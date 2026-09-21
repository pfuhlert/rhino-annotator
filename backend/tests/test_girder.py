from simple_annotator.config import CROP_SIZE
from simple_annotator.girder import _region


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
