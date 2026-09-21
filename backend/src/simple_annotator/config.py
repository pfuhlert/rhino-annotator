import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[3] / ".env")

COOKIE_NAME = "sa_session"
CROP_SIZE = int(os.environ.get("CROP_SIZE", "1024"))
FULL_IMAGE_MAX = int(os.environ.get("FULL_IMAGE_MAX", "4096"))
GIRDER_API_URL = os.environ.get("GIRDER_API_URL", "https://rhinodb.ims.bio/api/v1")
GIRDER_FOLDER_ID = os.environ.get("GIRDER_FOLDER_ID", "")
GIRDER_TOKEN = os.environ.get("GIRDER_TOKEN", "")


def sqlite_path() -> Path:
    raw = os.environ.get("SIMPLE_ANNOTATOR_SQLITE")
    if raw:
        return Path(raw)
    data_dir = Path(__file__).resolve().parents[2] / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "annotator.sqlite"
