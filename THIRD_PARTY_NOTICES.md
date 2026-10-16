# Third-party notices

Local Arena code is MIT licensed. The license does not replace the terms for bundled fonts or benchmark material. Local Arena's question adaptations retain each source's stated license, including share-alike terms. Model weights and inference runtimes are not bundled.

## Geist fonts

The files under app/fonts are Geist Sans and Geist Mono. Copyright 2024 The Geist Project Authors. They retain the SIL Open Font License 1.1, reproduced in [Geist-OFL.txt](docs/licenses/Geist-OFL.txt). Source: https://github.com/vercel/geist-font.

## Benchmark questions

The 704 questions and their selected source rows remain under the licenses below. Every generated question retains source_url, licence, split, source_row and edits. Adaptations include added reply-format instructions, joined premises or passages, option labels and instruction-rule mappings; each row describes its edits. Local Arena's selection and deterministic grading do not represent endorsement or an official benchmark score.

| Source and attribution | Questions | Upstream license | Source |
| --- | ---: | --- | --- |
| ARC-Challenge; Allen Institute for AI | 27 | CC-BY-SA-4.0 | https://huggingface.co/datasets/allenai/ai2_arc/resolve/main/ARC-Challenge/test-00000-of-00001.parquet |
| BBH; BBH authors | 40 | MIT | https://raw.githubusercontent.com/suzgunmirac/BIG-Bench-Hard/main/bbh/boolean_expressions.json |
| BoolQ; Clark et al., Google Research | 40 | CC-BY-SA-3.0 | https://huggingface.co/datasets/google/boolq/resolve/main/data/validation-00000-of-00001.parquet |
| CRUXEval; CRUXEval authors | 53 | MIT | https://huggingface.co/datasets/cruxeval-org/cruxeval/resolve/main/test.jsonl |
| CommonsenseQA; Talmor et al., CommonsenseQA authors | 8 | MIT | https://huggingface.co/datasets/tau/commonsense_qa/resolve/main/data/validation-00000-of-00001.parquet |
| DROP; Dua et al., Allen Institute for AI | 40 | CC-BY-SA-4.0 | https://huggingface.co/datasets/ucinlp/drop/resolve/main/data/validation-00000-of-00001.parquet |
| FOLIO; Han et al., Yale LILY | 40 | CC-BY-SA-4.0 | https://raw.githubusercontent.com/Yale-LILY/FOLIO/main/data/v0.0/folio-validation.jsonl |
| GSM8K; GSM8K authors | 40 | MIT | https://huggingface.co/datasets/openai/gsm8k/resolve/main/main/test-00000-of-00001.parquet |
| HotpotQA; Yang et al. | 40 | CC-BY-SA-4.0 | https://huggingface.co/datasets/hotpotqa/hotpot_qa/resolve/main/distractor/validation-00000-of-00001.parquet |
| IFEval; Google Research | 122 | Apache-2.0 | https://huggingface.co/datasets/google/IFEval/resolve/main/ifeval_input_data.jsonl |
| MATH-500; MATH-500 authors | 40 | MIT | https://huggingface.co/datasets/HuggingFaceH4/MATH-500/resolve/main/test.jsonl |
| MMLU-Pro; TIGER-Lab | 27 | MIT | https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro/resolve/main/data/test-00000-of-00001.parquet |
| MMLU-Redux; Gema et al., Edinburgh DAWG | 27 | CC-BY-4.0 | https://huggingface.co/datasets/edinburgh-dawg/mmlu-redux/resolve/main/anatomy/test.csv |
| Omni-MATH; Omni-MATH authors | 40 | Apache-2.0 | https://huggingface.co/datasets/KbsdJames/Omni-MATH/resolve/main/test.jsonl |
| SQuAD 2.0; Rajpurkar et al., Stanford NLP | 40 | CC-BY-SA-4.0 | https://huggingface.co/datasets/rajpurkar/squad_v2/resolve/main/squad_v2/validation-00000-of-00001.parquet |
| StrategyQA; StrategyQA authors | 40 | MIT | https://huggingface.co/datasets/ChilleD/StrategyQA/resolve/main/test.json |
| TheoremQA; TheoremQA authors | 40 | MIT | https://huggingface.co/datasets/TIGER-Lab/TheoremQA/resolve/main/data/test-00000-of-00001.parquet |

MIT source copyright notices and full texts are preserved under docs/licenses: BBH (2022 suzgunmirac), CRUXEval (2023 Meta), GSM8K (2021 OpenAI), MATH-500's PRM800K upstream (2023 OpenAI), TheoremQA (2024 TIGER Lab), and StrategyQA (2021 Elad Segal). CommonsenseQA's authors confirm MIT at https://github.com/jonathanherzig/commonsenseqa/issues/5. MMLU-Pro's dataset card declares MIT at https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro/raw/main/README.md; its evaluation-code license is separate. The MIT permission and disclaimer text is included in those license files.

MATH-500's candidate notes retain an upstream-license inference through PRM800K. This is not independent permission from every original problem author.

The Apache-2.0 text is [included here](docs/licenses/Apache-2.0.txt). IFEval's publisher is Google Research; Omni-MATH's publisher card declares Apache-2.0. Creative Commons legal texts are included as [CC-BY-SA-4.0](docs/licenses/CC-BY-SA-4.0.html), [CC-BY-SA-3.0](docs/licenses/CC-BY-SA-3.0.html) and [CC-BY-4.0](docs/licenses/CC-BY-4.0.html). Attribution, source links and changes travel with the rows; adapters retain the relevant terms.

Unused candidate sources are excluded from the distributed corpus. Downloaded raw files are ignored. The code MIT license does not relicense any question, passage or font.
