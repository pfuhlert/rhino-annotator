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
def test_walk_lists_images_under_a_folder_or_collection(selected_id, monkeypatch):
    monkeypatch.setenv("GIRDER_TOKEN", "test")
    kind = "collection" if selected_id == "dataset" else "folder"
    meta = {"staining": "PAS", "scanner": "unused"}
    items = [
        {"_id": "file", "name": "Slide.dat", "folderId": "nested"},
        {"_id": "image", "name": "sample.tif", "folderId": "nested", "meta": meta},
    ]

    def respond(request):
        path, params = request.url.path, request.url.params
        if path == "/folder/dataset":
            return httpx.Response(400, json={"message": "Folder not found."})
        if path in {"/collection/dataset", "/folder/folder"}:
            return httpx.Response(200, json={"_id": selected_id})
        if path == "/folder/nested":
            return httpx.Response(200, json={"_id": "nested", "name": "N2768-13"})
        if path == f"/resource/{selected_id}/items" and params["type"] == kind:
            offset, limit = int(params["offset"]), int(params["limit"])
            return httpx.Response(200, json=items[offset : offset + limit])
        pytest.fail(f"Unexpected request: {request.url}")

    with httpx.Client(base_url="https://girder.test", transport=httpx.MockTransport(respond)) as gc:
        monkeypatch.setattr(girder, "_gc", gc)
        images = girder.walk_images(selected_id)
    assert images == [
        {
            "_id": "image",
            "name": "sample.tif",
            "folderId": "nested",
            "folder_name": "N2768-13",
            "meta": {"staining": "PAS"},
        }
    ]


@pytest.fixture
def calibration_client(monkeypatch):
    monkeypatch.setenv("GIRDER_TOKEN", "test")
    girder._image_nm_per_px.cache_clear()
    girder._kinds.clear()
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


def test_folder_kind_is_cached_but_failures_are_retried(calibration_client):
    responses, calls = calibration_client
    responses["/folder/tem"] = 503
    assert girder.folder_kind("tem") == "histo"
    responses["/folder/tem"] = {"name": "TEM", "parentId": "elmi"}
    assert girder.folder_kind("tem") == "elmi"
    assert girder.folder_kind("tem") == "elmi"
    assert girder.folder_kind("histo") == "histo"
    assert calls.count("/folder/tem") == 2


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
