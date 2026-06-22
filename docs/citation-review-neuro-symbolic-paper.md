# Citation Review as a Neuro-Symbolic AI Case Study — Paper Scaffold

Working notes for a research paper presenting Hyperlit's `citation:review` pipeline as a
neuro-symbolic AI system for citation verification, evaluated as a digital-humanities case study.

> **Verification status of all references below:** assembled by automated web research that
> cross-checked each work against ≥2 independent indexes (publisher, PubMed/PMC, arXiv, DBLP,
> ACL Anthology, NeurIPS proceedings). Live page fetches were blocked (HTTP 403) in the research
> environment, so **do a one-click DOI/identifier resolve on every reference before submission.**
> Several *future-dated* arXiv IDs surfaced during searching (e.g. "CiteCheck", "GhostCite",
> "SemanticCite") and were **deliberately excluded as probable hallucinations** — do not cite any
> 2026-dated preprint without resolving its abstract page first.

---

## 1. Is this "literally a scientific experiment"? — Yes, with one structural caveat

You have a clean controlled design:

- **Independent variable:** the system configuration (ablations — see §4).
- **Dependent variables:** the per-citation verdict (`confirmed/likely/plausible/unlikely/rejected`),
  the resolution tier (`canonical/web/local/unverified`), and the verbatim-guardrail pass/fail.
- **Labelled conditions:** legitimate citations (control) vs. two kinds of bad citation (treatment).

**The caveat that shapes everything:** your system tests two *different* failure modes through two
*different* mechanisms, so they must be **separate experimental arms** (you chose this — correct):

| Arm | Failure mode | Pipeline stage that catches it | Expected system behaviour |
|---|---|---|---|
| **Arm 1** | **Content mismatch** — a real, resolvable source that does **not** support the claim | Phase 5 **verify** (LLM verdict over FTS-retrieved passages) | verdict skews `unlikely`/`rejected`; legit controls skew `confirmed`/`likely` |
| **Arm 2** | **Fabricated reference** — the cited work does not exist | Phase 2 **enrich/resolve** (`foundation_source = unknown`) | flagged `unverified` / "no evidence available" — never resolves to a source |

This is itself a *finding* worth stating: a fabricated reference and a misused-but-real reference
are caught by structurally different parts of a neuro-symbolic pipeline (symbolic resolution vs.
neural verification). Most "AI citation checker" framings conflate them.

---

## 2. Hypotheses (state them explicitly)

- **H1 (discrimination):** The full pipeline assigns systematically lower support verdicts to
  content-mismatched citations (Arm 1) than to legitimate ones (control).
- **H2 (resolution):** Fabricated references (Arm 2) fail to resolve to a verified source at a
  rate far higher than legitimate references.
- **H3 (symbolic contribution):** Each symbolic component — the verbatim-match guardrail,
  provenance-tier-routed prompting, and full-text retrieval — measurably improves performance
  over a neural-only baseline (the core neuro-symbolic claim).
- **H4 (retrieval, optional):** Adding dense embedding retrieval to the symbolic FTS changes
  recall of supporting passages (direction is an empirical question — this is your "easy to add,
  easy to compare" lever).

---

## 3. Mapping the system to the neuro-symbolic taxonomy

**Do not present "compositional vs. integrated" as a single canonical published binary — it isn't.**
Define your terms and anchor them to **Kautz's category labels** (Kautz 2022). Position the system
as a *loosely-coupled / compositional* neuro-symbolic architecture (LLM reasoning bounded by symbolic
provenance, retrieval, and a hard verbatim constraint), explicitly **not** the integrated/differentiable
end (Garcez & Lamb's "3rd wave" ideal).

| Component | Paradigm | Role |
|---|---|---|
| Provenance/authority tiers (OpenAlex/DOI/Open Library identity → `canonical>web>local>unverified`) | Symbolic (KB + rules) | source resolution & trust |
| Version precedence (`author→publisher→commons→auto`) | Symbolic (rules) | which copy is authoritative |
| Full-text search (escalating `tsquery` strategies) | Symbolic (IR) | evidence retrieval |
| `[CITE]`/`[FNCITE]` marker grammar (directional attachment) | Symbolic | constrains neural claim extraction |
| **Verbatim-match guardrail** (claim must appear in source text or be dropped) | Symbolic verifier over neural output | **hallucination suppression** |
| `evidence_type` → prompt routing (`title_only` forbids `confirmed`, etc.) | Symbolic gating | bounds neural verdict space |
| Truth-claim extraction, abstract validation, verdict, rejection-review | Neural (LLM) | reasoning |

The bidirectional coupling (symbolic state routes neural prompts; neural output feeds symbolic
retrieval; symbolic verifier filters neural output) is the paper's architectural contribution.

---

## 4. Experimental design

**Corpus.** Papers with (a) all-legitimate citations [control], (b) injected/known content
mismatches [Arm 1], (c) injected/known fabricated references [Arm 2]. Report discipline mix; the
existing citation-accuracy literature is medicine-heavy, so a humanities corpus is a contribution
but limits comparability (see §6).

**Ablations (the IV) — these are what *prove* the neuro-symbolic claim:**
1. **Neural-only** — LLM verdict on the claim with no verbatim guardrail, no tier routing, no FTS.
2. **+ symbolic retrieval (FTS)** — add Phase 4 passage search.
3. **+ verbatim guardrail + tier routing** — add the symbolic constraints.
4. **Full system.**
5. **Full + embeddings** — dense retrieval added to FTS (your H4 lever).

**Metrics:**
- Per-arm precision / recall / F1 for "flagged as problematic" (binarise the 5-point scale).
- Verdict-distribution shift between control and Arm 1 (ordinal; report a Mann–Whitney or
  proportional-odds model, not just means).
- Arm 2 resolution-failure rate (the `unverified` rate).
- **Verbatim-guardrail hallucination-rejection rate** (claims dropped as non-verbatim) — direct
  evidence the symbolic verifier does work.
- Rejection-review upgrade rate (false-rejection correction).
- Calibration / AUC if you treat support as a score.
- Use `temperature=0.0` (already set); still report run-to-run variance across ≥3 seeds, since
  LLM verdicts are not perfectly deterministic.

**Evaluation paradigm to cite:** map your verdicts onto the FEVER `Supported/Refuted/NotEnoughInfo`
scheme (Thorne et al. 2018) and SciFact's claim+rationale labelling (Wadden et al. 2020); borrow
ALCE's citation precision/recall (Gao et al. 2023) and CiteME's attribution-accuracy framing
(Press et al. 2024) for the metric definitions.

---

## 5. What the experiment CAN and CANNOT show

**Can show**
- Whether the pipeline *discriminates* legitimate from problematic citations (H1, H2).
- The *marginal contribution of each symbolic component* (H3) — the central thesis.
- That fabricated vs. mismatched citations are caught by *different mechanisms* (resolution vs.
  verification) — a qualitative architectural finding.
- Whether embeddings help retrieval (H4).

**Cannot show (state these as scope limits, not weaknesses to hide)**
- **Real-world prevalence/base rates** — a constructed test set cannot estimate how common bad
  citations are in the wild.
- **Generalisation** beyond the disciplines, source types, and OA coverage in your corpus.
- **Ground-truth "truth"** of claims in contested humanities scholarship — you need *human* gold
  labels with inter-annotator agreement, or your evaluation is an LLM grading an LLM (circular).
- **Downstream impact** — that it changes reviewer behaviour or catches errors in real peer review
  (needs a deployment / user study; cf. Liang et al. 2024).
- **Causal "the system detects accuracy"** — see the confound below.

**Validity threats (pre-empt them)**
- **Construct validity (the big one):** "supported" is operationalised by an LLM verdict. Break the
  circularity with an independent human-annotated gold set; report agreement.
- **Internal validity — source-availability confound:** legitimate citations may have *more
  retrievable full text* than fabricated ones (which have none by definition). The system could be
  detecting "has retrievable content" rather than "is accurate." **Control:** ensure Arm 1
  (mismatch) uses real, fully-retrievable sources, so the *only* difference from the control is
  support, not availability.
- **External validity:** the citation-accuracy evidence base is biomedical; your DH framing is
  novel but limits direct comparison.
- **Selection / construction:** synthetic injected errors may be easier to catch than naturally
  occurring ones — report how you constructed each arm and, ideally, include some naturally
  occurring cases.

---

## 6. Reference set (verify DOIs before use)

### A. Neuro-symbolic AI (taxonomy / positioning)
- **Kautz, H. (2022). "The third AI summer: AAAI Robert S. Engelmore Memorial Lecture." *AI
  Magazine* 43(1), 105–125. DOI 10.1002/aaai.12036.** — THE citable source for the taxonomy you
  invoke; anchor your "compositional/loosely-coupled" classification to his category labels.
- **d'Avila Garcez, A. & Lamb, L. C. (2023). "Neurosymbolic AI: the 3rd wave." *Artificial
  Intelligence Review* 56(11), 12387–12406. DOI 10.1007/s10462-023-10448-w.** — the
  integrated/differentiable *ideal* you position against.
- **d'Avila Garcez, A. S., Broda, K. B. & Gabbay, D. M. (2002). *Neural-Symbolic Learning Systems.*
  Springer. DOI 10.1007/978-1-4471-0211-3.** — foundational monograph (historical grounding).
- **d'Avila Garcez, A. S., Lamb, L. C. & Gabbay, D. M. (2009). *Neural-Symbolic Cognitive
  Reasoning.* Springer. DOI 10.1007/978-3-540-73246-4.** — pair with the above.
- **Sarker, M. K., Zhou, L., Eberhart, A. & Hitzler, P. (2021). "Neuro-symbolic artificial
  intelligence: Current trends." *AI Communications* 34(3), 197–209. DOI 10.3233/AIC-210084.** —
  recent survey extending the taxonomy. *(Verify the subtitle.)*
- *(Optional framing)* **Kahneman, D. (2011). *Thinking, Fast and Slow.* FSG.** — only for the
  System 1/System 2 analogy both Kautz and Garcez/Lamb invoke; not itself NeSy literature.

### B. Citation/quotation accuracy crisis (pre-LLM) — strong, mature literature
Terminology to adopt: **citation errors** (formal/bibliographic) vs. **quotation/content errors**
(source doesn't support the assertion) — major (unsupported/contradicted) vs. minor. Your two arms
map onto fabrication (extreme citation error) and quotation error (content mismatch).
- **de Lacey, G., Record, C. & Wade, J. (1985). "How accurate are quotations and references in
  medical journals?" *BMJ* 291(6499), 884–886. DOI 10.1136/bmj.291.6499.884.** — origin study;
  ~15% quotation errors. *(Confirm the "6.3% seriously misleading" figure at source.)*
- **Evans, J. T., Nadjari, H. I. & Burchell, S. A. (1990). "Quotational and reference accuracy in
  surgical journals." *JAMA* 263(10), 1353–1354. DOI 10.1001/jama.1990.03440100059009.** — ~30%
  quotation errors; framed as a peer-review failure.
- **Jergas, H. & Baethge, C. (2015). "Quotation accuracy in medical journal articles — a systematic
  review and meta-analysis." *PeerJ* 3:e1364. DOI 10.7717/peerj.1364.** — the canonical pooled
  figure: **25.4% quotation errors, 11.9% major.**
- **Mogull, S. A. (2017). "Accuracy of cited 'facts' in medical research articles…" *PLOS ONE*
  12(9):e0184727. DOI 10.1371/journal.pone.0184727.** — sharpens citation-vs-quotation /
  major-vs-minor distinction (recalculated ~14.5%); use to bracket the estimate.
- *(Most current, optional)* **Baethge, C. & Jergas, H. (2025). "Systematic review and meta-analysis
  of quotation inaccuracy in medicine." *Research Integrity and Peer Review* 10:13. DOI
  10.1186/s41073-025-00173-z.** — ~16.9% incorrect; **no improvement over time.** *(Re-confirm at
  source; postdates strict pre-LLM framing.)*

### C. LLM-fabricated citations (2023–2025) — motivation for Arm 2
- **Bhattacharyya, M. et al. (2023). "High Rates of Fabricated and Inaccurate References in
  ChatGPT-Generated Medical Content." *Cureus* 15(5):e39238. DOI 10.7759/cureus.39238.** —
  **47% fabricated, 46% inaccurate, 7% correct.**
- **Walters, W. H. & Wilder, E. I. (2023). "Fabrication and errors in the bibliographic citations
  generated by ChatGPT." *Scientific Reports* 13:14045. DOI 10.1038/s41598-023-41032-5.** —
  **55% (GPT-3.5) vs 18% (GPT-4) fabricated**; shows model dependence.
- **Ji, Z. et al. (2023). "Survey of Hallucination in Natural Language Generation." *ACM Computing
  Surveys* 55(12):248. DOI 10.1145/3571730.** — canonical intrinsic/extrinsic hallucination
  definition.
- **Mata v. Avianca, Inc., 678 F. Supp. 3d 443 (S.D.N.Y. 2023)** (Castel, J., June 22 2023; Case
  22-cv-1461). — fabricated citations + $5,000 sanctions; real-world fallout. *(Confirm reporter
  pagination if citing in legal format.)*
- *(Optional, second domain)* **Gravel, J., Osmanlliu, E. et al. (2023). "Learning to Fake It…"
  *Mayo Clinic Proceedings: Digital Health* 1(3), 226–234. DOI 10.1016/j.mcpdig.2023.05.004.**
  *(Treat precise DOI-mismatch percentages as moderately-evidenced.)*

### D. Automated claim / citation verification (prior art & metrics)
- **Thorne, J. et al. (2018). "FEVER: a Large-scale Dataset for Fact Extraction and VERification."
  NAACL-HLT, 809–819. arXiv:1803.05355.** — the claim-verification task definition.
- **Wadden, D. et al. (2020). "Fact or Fiction: Verifying Scientific Claims." EMNLP, 7534–7550.
  arXiv:2004.14974.** — SciFact; scientific claim+rationale verification.
- **Teufel, S., Siddharthan, A. & Tidhar, D. (2006). "Automatic Classification of Citation
  Function." EMNLP, 103–110.** — citation-context analysis roots.
- **Cohan, A. et al. (2019). "Structural Scaffolds for Citation Intent Classification." NAACL-HLT,
  3586–3596. arXiv:1904.01608.** — SciCite; modern citation-intent benchmark.
- **Nicholson, J. M. et al. (2021). "scite: A smart citation index…" *Quantitative Science Studies*
  2(3), 882–898. DOI 10.1162/qss_a_00146.** — deployed Smart Citations (supporting/contrasting).
- **Lewis, P. et al. (2020). "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks."
  NeurIPS. arXiv:2005.11401.** — RAG backbone.
- **Gao, T., Yen, H., Yu, J. & Chen, D. (2023). "Enabling Large Language Models to Generate Text
  with Citations." EMNLP, 6465–6488. arXiv:2305.14627.** — ALCE; citation precision/recall metrics.
- **Press, O. et al. (2024). "CiteME: Can Language Models Accurately Cite Scientific Claims?"
  NeurIPS D&B. arXiv:2407.12861.** — LMs 4.2–18.5% vs humans 69.7% on attribution; closest prior
  art to "LLM citation verification" (this sub-area is *real but thin* — your gap to fill).
- *(Optional)* **Gao, L. et al. (2023). "RARR…" ACL, 16477–16508. arXiv:2210.08726**;
  **Zhang, T. M. & Abernethy, N. F. (2024). "Detecting Reference Errors… with LLMs." arXiv:2411.06101**
  *(preprint).*

### E. AI in digital humanities (the case-study framing)
- **Moretti, F. (2013). *Distant Reading.* Verso. ISBN 9781781680841.** — computational method as
  legitimate humanities scholarship.
- **Schreibman, S., Siemens, R. & Unsworth, J. (eds.) (2004/2016). *A (New) Companion to Digital
  Humanities.* Blackwell/Wiley. (2nd ed. DOI 10.1002/9781118680605.)** — field-defining reference.
- **Goodlad, L. M. E. (2023). "Editor's Introduction: Humanities in the Loop." *Critical AI* 1(1–2).
  DOI 10.1215/2834703X-10734016.** — the assistive / human-in-the-loop, critical-not-deferential
  stance your README already embodies.
- *(Recent, preprint)* **Klein, L. et al. (2025). "Provocations from the Humanities for Generative
  AI Research." arXiv:2502.19190.** — current critical-perspective anchor. *(Preprint — flag.)*

### F. AI-assisted peer review & citation-checking need (the practical motivation)
- **Liang, W. et al. (2024). "Can Large Language Models Provide Useful Feedback on Research Papers?…"
  *NEJM AI* 1(8). DOI 10.1056/AIoa2400196.** — large-scale evidence AI peer-review feedback is useful.
- **Kousha, K. & Thelwall, M. (2024). "Artificial intelligence to support publishing and peer
  review: A summary and review." *Learned Publishing* 37(1), 4–12. DOI 10.1002/leap.1570.** — surveys
  existing reference/compliance checkers (statcheck, SciScore…); situates your tool.
- **Barroga, E. F. (2014). "Reference Accuracy: Authors', Reviewers', Editors', and Publishers'
  Contributions." *J. Korean Med. Sci.* 29(12), 1587–1589. DOI 10.3346/jkms.2014.29.12.1587.** —
  documents the reviewer/editor *burden* of citation checking (your need statement).
- **COPE — "When citation integrity is questioned."** publicationethics.org. — citation integrity as
  a research-integrity concern. *(Institutional resource; confirm live URL + access date — fetch
  was blocked.)*

---

## 7. Introduction — narrative arc

1. **The citation-integrity problem is old and measured.** Open with the pre-LLM evidence: a stable
   ~15–25% of citations misrepresent their sources, ~8–12% seriously, with *no improvement over
   decades* (de Lacey 1985 → Jergas & Baethge 2015/2025). Citation checking is a known, unmet burden
   on reviewers and editors (Barroga 2014; COPE).
2. **LLMs make it acute — and might help.** Generative models fabricate references at high rates
   (Bhattacharyya 2023: 47%; Walters & Wilder 2023: 55%/18%), with real consequences (Mata v.
   Avianca). The same technology that worsens the problem could, if *constrained*, help detect it.
3. **Pure-neural verification is unreliable; pure-symbolic is brittle.** LMs are poor at attribution
   (CiteME: <19% vs 70% human) and hallucinate; symbolic IR/fact-checking (FEVER, SciFact, scite)
   is reliable but shallow on meaning. → motivates a **neuro-symbolic** approach (Kautz 2022;
   Garcez & Lamb 2023).
4. **Our system.** A compositional neuro-symbolic citation-review pipeline where symbolic provenance
   resolution, full-text retrieval, and a hard verbatim guardrail constrain LLM extraction and
   verdicts, producing a *graded, auditable* assessment rather than a binary verdict.
5. **Digital-humanities case study.** Framed as assistive, human-in-the-loop scholarship (Goodlad
   2023; the README's "flag, not verdict" stance) — appropriate for contested humanities sources
   read "against the grain."
6. **Contributions (bullet them):** (i) the architecture + the bidirectional symbolic↔neural
   coupling; (ii) the two-failure-mode framing (fabrication vs. content-mismatch caught by different
   stages); (iii) an ablation quantifying each symbolic component's contribution; (iv) a DH
   evaluation corpus/protocol.

## 8. Literature-review section outline
- **2.1 Citation integrity** (B) — the problem and its persistence.
- **2.2 LLMs and citation fabrication** (C) — the new acuteness.
- **2.3 Automated claim & citation verification** (D) — prior art and where it stops (no
  meaning-aware, provenance-grounded, hallucination-guarded verifier).
- **2.4 Neuro-symbolic AI** (A) — taxonomy; define compositional vs. integrated; place this work.
- **2.5 AI in digital humanities & peer review** (E, F) — the application context and the
  assistive-tool stance.

## 9. Venue recommendation (you asked me to pick)
Lead with a **research-integrity / scientometrics** venue, where the need is explicit and the
evaluation paradigm (error rates, peer-review tooling) is native:
- **Primary:** *Research Integrity and Peer Review* (BMC) — exact topical fit; already publishes the
  Baethge/Jergas line.
- **Strong alternatives:** *Quantitative Science Studies* (publishes scite); *Digital Scholarship in
  the Humanities* or *Digital Humanities Quarterly* if you want the DH-method framing to lead;
  *Scientometrics* for the metrics angle.
- **AI venue** (NeSy workshop, or a *neuro-symbolic*-themed track) only if the architecture, not the
  scholarly-communication problem, is your headline.
Cross-disciplinary framing that travels: *"a neuro-symbolic, human-in-the-loop tool for citation
integrity, demonstrated on humanities scholarship."*
