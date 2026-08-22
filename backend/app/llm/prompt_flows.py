from __future__ import annotations

from app.llm.prompt import SYSTEM_PROMPT
from app.llm.task_prompt import SCREENING_SYSTEM_PROMPT, VALIDATION_SYSTEM_PROMPT

PROMPT_FLOW_LABELS: dict[str, str] = {
    "titleAbstract": "Title/abstract screening",
    "fullText": "Full-text screening",
    "extraction": "Data extraction",
    "validation": "Extraction validation",
}

PROMPT_FLOW_DEFAULTS: dict[str, str] = {
    "titleAbstract": SCREENING_SYSTEM_PROMPT,
    "fullText": SCREENING_SYSTEM_PROMPT,
    "extraction": SYSTEM_PROMPT,
    "validation": VALIDATION_SYSTEM_PROMPT,
}
