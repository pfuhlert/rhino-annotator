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
