import httpx
import pytest

from simple_annotator import girder


def test_girder_client_bypasses_http_proxy(monkeypatch):
    seen = {}
    real = httpx.Client

    def respond(request):
        if request.url.path == "/user/me":
            return httpx.Response(200, json={"login": "test"})
        pytest.fail(f"Unexpected request: {request.url}")

    def capture(**kw):
        seen.update(kw)
        return real(transport=httpx.MockTransport(respond), **kw)

    monkeypatch.setattr(girder, "_gc", None)
    monkeypatch.setenv("GIRDER_TOKEN", "test")
    monkeypatch.setattr(girder, "GIRDER_API_URL", "http://girder.test")
    monkeypatch.setattr(httpx, "Client", capture)
    girder._client()
    assert seen.get("trust_env") is False


@pytest.mark.parametrize("selected_id", ["dataset", "folder"])
def test_folder_images_from_folder_or_collection(selected_id, monkeypatch):
    monkeypatch.setenv("GIRDER_TOKEN", "test")
    monkeypatch.setattr(girder, "_images_cache", {})
    monkeypatch.setattr(girder, "_kids_cache", {})

    def respond(request):
        path = request.url.path
        if path == "/folder/dataset":
            return httpx.Response(400, json={"message": "Folder not found."})
        if path in {"/collection/dataset", "/folder/folder"}:
            return httpx.Response(200, json={"_id": selected_id})
        if path == "/folder":
            parent = (request.url.params["parentType"], request.url.params["parentId"])
            children = {
                ("collection", "dataset"): [{"_id": "folder", "name": "Folder"}],
                ("folder", "folder"): [{"_id": "nested", "name": "N2768-13"}],
                ("folder", "nested"): [],
            }
            return httpx.Response(200, json=children[parent])
        if path == "/item":
            folder_id = request.url.params["folderId"]
            assert folder_id in {"folder", "nested"}
            items = [{"_id": "image", "name": "sample.tif"}] if folder_id == "nested" else []
            return httpx.Response(200, json=items)
        pytest.fail(f"Unexpected request: {request.url}")

    with httpx.Client(base_url="https://girder.test", transport=httpx.MockTransport(respond)) as gc:
        monkeypatch.setattr(girder, "_gc", gc)
        images = girder.folder_images(selected_id)
    assert [(image["_id"], image["folder_name"]) for image in images] == [("image", "N2768-13")]


def test_subfolders_are_listed_past_one_page(monkeypatch):
    monkeypatch.setenv("GIRDER_TOKEN", "test")
    monkeypatch.setattr(girder, "_kids_cache", {})
    cases = [{"_id": f"case{i}", "name": f"N{i}"} for i in range(1203)]

    def respond(request):
        assert request.url.path == "/folder"
        offset, limit = int(request.url.params["offset"]), int(request.url.params["limit"])
        return httpx.Response(200, json=cases[offset : offset + limit])

    with httpx.Client(base_url="https://girder.test", transport=httpx.MockTransport(respond)) as gc:
        monkeypatch.setattr(girder, "_gc", gc)
        assert girder._kids("folder", "year") == cases


def test_item_errors_are_not_cached_as_images(monkeypatch):
    monkeypatch.setattr(girder, "_images_cache", {})
    transport = httpx.MockTransport(
        lambda request: httpx.Response(403, json={"message": "Access denied."})
    )
    with httpx.Client(base_url="https://girder.test", transport=transport) as gc:
        monkeypatch.setattr(girder, "_gc", gc)
        with pytest.raises(httpx.HTTPStatusError):
            girder._images("denied")
    assert "denied" not in girder._images_cache


@pytest.fixture
def calibration_client(monkeypatch):
    monkeypatch.setenv("GIRDER_TOKEN", "test")
    girder._image_nm_per_px.cache_clear()
    responses = {
        "/item/a": {"folderId": "tem", "meta": {"nm_per_px": 0.48828125}},
        "/item/b": {"folderId": "tem", "meta": {"nm_per_px": 4.8828125}},
        "/folder/tem": {"name": "TEM", "parentId": "elmi"},
        "/folder/elmi": {"name": "ELMI"},
        "/folder/histo": {"name": "HISTO"},
        "/item/a/tiles/internal_metadata": {"xml": {"nm_per_px": 1.220703125}},
    }
    calls = []

    def respond(request):
        path = request.url.path
        calls.append(path)
        data = responses[path]
        return (
            httpx.Response(data, json={})
            if isinstance(data, int)
            else httpx.Response(200, json=data)
        )

    with httpx.Client(base_url="https://girder.test", transport=httpx.MockTransport(respond)) as gc:
        monkeypatch.setattr(girder, "_gc", gc)
        yield responses, calls
    girder._image_nm_per_px.cache_clear()


def test_is_elmi_folder_returns_false_on_girder_failure(calibration_client):
    responses, _ = calibration_client
    responses["/folder/tem"] = 503
    assert girder.is_elmi_folder("tem") is False


def test_tem_calibration_is_per_image_and_cached(calibration_client):
    _, calls = calibration_client
    assert girder.image_nm_per_px("a") == 0.48828125
    assert girder.image_nm_per_px("b") == 4.8828125
    assert girder.image_nm_per_px("a") == 0.48828125
    assert calls.count("/item/a") == 1


def test_tem_calibration_falls_back_to_embedded_tiff_metadata(calibration_client):
    responses, _ = calibration_client
    responses["/item/a"]["meta"] = {}
    assert girder.image_nm_per_px("a") == 1.220703125


@pytest.mark.parametrize("value", [0, -1, "unknown", True])
def test_invalid_calibration_is_hidden(calibration_client, value):
    responses, _ = calibration_client
    responses["/item/a"]["meta"]["nm_per_px"] = value
    assert girder.image_nm_per_px("a") is None


def test_missing_calibration_and_non_tem_images_are_hidden(calibration_client):
    responses, calls = calibration_client
    responses["/item/a"]["meta"] = {"magnification": 83000}
    responses["/item/a/tiles/internal_metadata"] = {}
    responses["/item/b"]["folderId"] = "histo"
    assert girder.image_nm_per_px("a") is None
    assert girder.image_nm_per_px("b") is None
    assert girder.image_nm_per_px("placeholder") is None
    assert "/item/placeholder" not in calls


@pytest.mark.parametrize("path", ["/item/a", "/folder/tem", "/folder/elmi"])
def test_calibration_failure_does_not_block_image_and_is_retried(calibration_client, path):
    responses, calls = calibration_client
    data = responses[path]
    responses[path] = 503
    assert girder.image_nm_per_px("a") is None
    responses[path] = data
    assert girder.image_nm_per_px("a") == 0.48828125
    assert calls.count(path) == 2


@pytest.mark.parametrize(
    "pixels, expected",
    [
        ({"PhysicalSizeX": "0.242534722222222", "PhysicalSizeXUnit": "µm"}, 242.534722222222),
        ({"PhysicalSizeX": "0.5"}, 500),
        ({"PhysicalSizeX": "250", "PhysicalSizeXUnit": "nm"}, 250),
        ({"PhysicalSizeX": "0.25", "PhysicalSizeXUnit": "pc"}, None),
        ({"PhysicalSizeX": "0"}, None),
        ({}, None),
    ],
)
def test_histology_scale_comes_from_the_ome_pixel_size(calibration_client, pixels, expected):
    responses, _ = calibration_client
    responses["/item/a/tiles/internal_metadata"] = {"xml": {"OME": {"Image": {"Pixels": pixels}}}}
    assert girder.ome_nm_per_px("a") == pytest.approx(expected)


def test_histology_scale_is_missing_without_ome_metadata(calibration_client):
    assert girder.ome_nm_per_px("a") is None
    assert girder.ome_nm_per_px("placeholder") is None
