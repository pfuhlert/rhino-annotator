import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[3] / ".env")

COOKIE_NAME = "sa_session"
CROP_SIZE = int(os.environ.get("CROP_SIZE", "1024"))
FULL_IMAGE_MAX = int(os.environ.get("FULL_IMAGE_MAX", "4096"))
CROP_OVERLAP = int(os.environ.get("CROP_OVERLAP", "256"))
# Histology is split into padded tissue regions; chunks of an oversized region overlap by more
# than the largest glomerulus so each one is whole in some chunk.
REGION_MAX_UM = float(os.environ.get("REGION_MAX_UM", "5000"))
REGION_PAD_UM = float(os.environ.get("REGION_PAD_UM", "250"))
REGION_MERGE_UM = float(os.environ.get("REGION_MERGE_UM", "200"))
TILE_OVERLAP_UM = float(os.environ.get("TILE_OVERLAP_UM", "300"))
TISSUE_MIN_AREA_UM2 = float(os.environ.get("TISSUE_MIN_AREA_UM2", "10000"))
GIRDER_API_URL = os.environ.get("GIRDER_API_URL", "https://rhinodb.ims.bio/api/v1")


@dataclass(frozen=True)
class AiModel:
    name: str
    arch: str
    # An https URL is downloaded into the model cache; anything else is a local file.
    source: str
    xxh128: str
    # Structures spanning the image need its full context rather than calibrated tiles.
    whole_image: bool = False


DEFAULT_AI_MODEL = AiModel(
    "microsam-em-vit_l-1.2",
    "vit_l",
    "https://uk1s3.embassy.ebi.ac.uk/public-datasets/bioimage.io/humorous-crab/1.2/files/vit_l.pt",
    "810b084b6e51acdbf760a993d8619f2d",
)
GBM_AI_MODEL = AiModel(
    "gbm-fpw-clahe-vit_l",
    "vit_l",
    os.environ.get(
        "SIMPLE_ANNOTATOR_GBM_CHECKPOINT",
        "/data/results/microsam/checkpoints/fpw_em_finetune_clahe/best_only_weights.pt",
    ),
    "eef396774c4f850839941f6dd25d9586",
    whole_image=True,
)
# The EM-tuned µSAM does not transfer to stained tissue; histology uses Meta's default SAM.
HISTO_AI_MODEL = AiModel(
    "sam-vit_h",
    "vit_h",
    "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_h_4b8939.pth",
    "97698fac30bd929c2e6d8d8cc15933c2",
)
AI_MODELS = {model.name: model for model in (DEFAULT_AI_MODEL, GBM_AI_MODEL, HISTO_AI_MODEL)}
JOB_AI_MODELS = {"GBM": GBM_AI_MODEL}


def job_ai_model(job_name: str | None, histo: bool = False) -> AiModel:
    return HISTO_AI_MODEL if histo else JOB_AI_MODELS.get(job_name, DEFAULT_AI_MODEL)


def sqlite_path() -> Path:
    raw = os.environ.get("SIMPLE_ANNOTATOR_SQLITE")
    if raw:
        return Path(raw)
    data_dir = Path(__file__).resolve().parents[2] / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "annotator.sqlite"
