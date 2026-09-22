import httpx
import pytest

from simple_annotator import girder
from simple_annotator.config import CROP_SIZE
from simple_annotator.girder import _region, pick_region


def test_region_full_for_tem_crop_for_wsi():
    assert _region("a", 2048, 2048) == {
        "girder_item_id": "a",
        "left": 0,
        "top": 0,
        "width": 2048,
        "height": 2048,
    }
    crop = _region("a", 50000, 40000)
    assert crop["girder_item_id"] == "a"
    assert crop["width"] == CROP_SIZE
    assert crop["height"] == CROP_SIZE
    assert 0 <= crop["left"] <= 50000 - CROP_SIZE
    assert 0 <= crop["top"] <= 40000 - CROP_SIZE


def test_pick_region_placeholder_is_full_crop():
    out = pick_region("placeholder")
    assert out == {
        "girder_item_id": "placeholder",
        "left": 0,
        "top": 0,
        "width": CROP_SIZE,
        "height": CROP_SIZE,
    }


@pytest.mark.parametrize("selected_id", ["dataset", "folder"])
def test_pick_region_from_folder_or_collection(selected_id, monkeypatch):
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
                ("collection", "dataset"): [{"_id": "folder"}],
                ("folder", "folder"): [{"_id": "nested"}],
                ("folder", "nested"): [],
            }
            return httpx.Response(200, json=children[parent])
        if path == "/item":
            folder_id = request.url.params["folderId"]
            assert folder_id in {"folder", "nested"}
            items = [{"_id": "image", "name": "sample.tif"}] if folder_id == "nested" else []
            return httpx.Response(200, json=items)
        if path == "/item/image/tiles":
            return httpx.Response(200, json={"sizeX": 256, "sizeY": 128})
        pytest.fail(f"Unexpected request: {request.url}")

    with httpx.Client(base_url="https://girder.test", transport=httpx.MockTransport(respond)) as gc:
        monkeypatch.setattr(girder, "_gc", gc)
        region = pick_region(selected_id)
    assert region["girder_item_id"] == "image"
    assert (region["width"], region["height"]) == (256, 128)


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
