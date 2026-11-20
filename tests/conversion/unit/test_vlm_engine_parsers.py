"""Engine adapters for the OCR comparison harness (tests/conversion/vlm_ocr_engines.py).

Each open engine's answer is mapped into the Mistral page shape the pipeline
replays. These pin the mappings that decide whether a foreign engine is scored
on what it READ rather than on how our adapter mangled it.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import vlm_ocr_engines as eng  # noqa: E402


def _cells(*cells):
    return json.dumps([{"bbox": [0, 0, 10, 10], "category": c, "text": t} for c, t in cells])


# --------------------------------------------------------------- olmOCR

def test_olmocr_fenced_front_matter_is_stripped():
    # DeepInfra's olmOCR-2 wraps its front matter in a ```yaml fence and puts the
    # page AFTER the closing fence — the old parser leaked both onto 2344 pages.
    raw = ("```yaml\nprimary_language: English\nis_rotation_valid: true\n"
           "rotation_correction: null\nis_table: false\nis_diagram: false\n```\n\n"
           "48. Vincent Larivière, 'The Oligopoly'")
    assert eng.parse_olmocr(raw) == "48. Vincent Larivière, 'The Oligopoly'"


def test_olmocr_parse_is_idempotent_on_already_leaked_cache():
    leaked = ("primary_language: English\nis_rotation_valid: true\nrotation_correction: null\n"
              "is_table: false\nis_diagram: false\n```\n\nBody text.")
    once = eng.parse_olmocr(leaked)
    assert once == "Body text."
    assert eng.parse_olmocr(once) == once


def test_olmocr_body_that_mentions_a_key_is_untouched():
    assert eng.parse_olmocr("The is_table flag is described below.") == \
        "The is_table flag is described below."


# --------------------------------------------------------------- dots.ocr

def test_dots_header_and_footer_go_to_their_own_fields():
    page = eng.parse_dots_page(_cells(
        ("Page-header", "JOURNAL OF THINGS 12"),
        ("Text", "Body paragraph."),
        ("Page-footer", "Page 3"),
    ))
    assert page == {"markdown": "Body paragraph.", "header": "JOURNAL OF THINGS 12",
                    "footer": "Page 3"}


def test_dots_footnote_cell_becomes_definitions():
    page = eng.parse_dots_page(_cells(
        ("Text", "A claim.$^{1}$ Another.<sup>2</sup>"),
        ("Footnote", "1 Smith, A. (2010) Things.\ncontinued here.\n² Ibid."),
    ))
    assert page["markdown"] == ("A claim.$^{1}$ Another.[^2]\n\n"
                                "[^1]: Smith, A. (2010) Things. continued here.\n\n[^2]: Ibid.")


def test_dots_footnote_without_a_number_is_left_alone():
    page = eng.parse_dots_page(_cells(("Footnote", "Translated by the author.")))
    assert page["markdown"] == "Translated by the author."


def test_dots_headings_formula_table_picture():
    page = eng.parse_dots_page(json.dumps([
        {"bbox": [0, 0, 1, 1], "category": "Title", "text": "A Book"},
        {"bbox": [0, 0, 1, 1], "category": "Section-header", "text": "Introduction"},
        {"bbox": [0, 0, 1, 1], "category": "Section-header", "text": "### Already marked"},
        {"bbox": [0, 0, 1, 1], "category": "Formula", "text": "E = mc^2"},
        {"bbox": [0, 0, 1, 1], "category": "Table", "text": "<table><tr><td>1</td></tr></table>"},
        {"bbox": [0, 0, 1, 1], "category": "Picture"},
    ]))
    assert page["markdown"].split("\n\n") == [
        "# A Book", "## Introduction", "### Already marked", "$$\nE = mc^2\n$$",
        '<table class="ocr-table"><tr><td>1</td></tr></table>',
    ]


def test_dots_truncated_json_salvages_complete_cells():
    # A page that hit max_tokens: the last cell is cut mid-string.
    full = _cells(("Text", "First."), ("Text", "Second."))
    truncated = full[:-1] + ', {"bbox": [0, 0, 1, 1], "category": "Text", "text": "Thi'
    assert eng.parse_dots_page(truncated)["markdown"] == "First.\n\nSecond."


def test_dots_prose_answer_falls_back_to_markdown():
    assert eng.parse_dots_page("Just some text.\n\nMore.")["markdown"] == "Just some text.\n\nMore."


def test_pod_preset_sends_image_first_with_dots_prompt():
    spec = eng.PRESETS["pod-dots"]
    assert spec.image_first and spec.raw_page_cache and spec.parser == "dots"
    assert spec.prompt.startswith("<|img|><|imgpad|><|endofimg|>Please output the layout")
