# P91 Scanner Recognition R&D — Scoreboard

Generated: 2026-09-03T00:00:42.542Z

## 01 — Baseline (production-equivalent CLS, pristine reference, single-crop query)

Corpus: 4296 cards. Query sample: 300. Confusable groups: 694 (covering 2973 cards).

| Profile | TOP1 | TOP3 | TOP5 | TOP20 | mean true-sim | mean nearest-wrong-sim |
|---|---|---|---|---|---|---|
| clean | 100% | 100% | 100% | 100% | 1 | 0.7525 |
| geometryOnly | 88% | 93.3% | 94% | 96.7% | 0.7961 | 0.7062 |
| hardGlareShadowBlur | 0% | 0% | 0.3% | 0.3% | 0.1277 | 0.4095 |
| hardShadowNoise | 0% | 0% | 0% | 0.3% | 0.135 | 0.4054 |

## 02 — Photometric normalization sweep (hard-defect profiles only)

### tilted-glare-shadow-blur

| Variant | TOP1 | TOP5 | mean true-sim |
|---|---|---|---|
| none | 0% | 0% | 0.126 |
| clahe | 0% | 0% | 0.1115 |
| grayWorld | 0% | 0% | 0.108 |
| percentileClip | 0% | 0% | 0.0843 |
| gammaAdaptive | 0% | 0% | 0.1262 |
| retinexSingleScale | 0% | 0% | 0.0813 |
| unsharpMask | 0% | 0% | 0.1096 |
| grayscaleTriplicate | 0% | 0% | 0.0806 |

### skewed-partial-shadow-noisy

| Variant | TOP1 | TOP5 | mean true-sim |
|---|---|---|---|
| none | 0% | 0% | 0.1286 |
| clahe | 0% | 0% | 0.1161 |
| grayWorld | 0% | 0% | 0.0771 |
| percentileClip | 0% | 0% | 0.1133 |
| gammaAdaptive | 0% | 0% | 0.128 |
| retinexSingleScale | 0% | 0% | 0.0561 |
| unsharpMask | 0% | 0% | 0.1236 |
| grayscaleTriplicate | 0% | 0% | 0.0834 |

## 03 — Reference-side augmentation / robust-centroid strategies

| Strategy | clean TOP1 | geometry TOP1 | glare/shadow/blur TOP1 | shadow/noise TOP1 |
|---|---|---|---|---|
| pristineOnly | 100% | 85% | 0% | 0% |
| centroidAll | 99.5% | 97.5% | 0% | 0% |
| trimmedMeanAll | 99.5% | 93.5% | 0% | 0% |
| medoidAll | 99% | 90% | 0% | 0% |
| pristinePlus1Aux | 100% | 98% | 0% | 0% |
| pristinePlus2Aux | 100% | 94% | 0% | 0% |
| pristinePlus4Aux | 100% | 98.5% | 0% | 0% |
| maxSimAllProtos | 100% | 98.5% | 0% | 0% |
| avgTop2AllProtos | 100% | 98.5% | 0% | 0% |

## 04 — DINO output-representation (pooling) sweep

| Variant | clean TOP1 | glare/shadow/blur TOP1 | shadow/noise TOP1 |
|---|---|---|---|
| cls | 100% | 0.2% | 0.2% |
| meanPatch | 100% | 0.2% | 0.2% |
| maxPatch | 100% | 0.2% | 0.2% |
| clsMeanBlend | 100% | 0.2% | 0.2% |
| centerPatch | 100% | 0% | 0.4% |
| gem | 100% | 0.2% | 0.2% |

## 05 — Capture-quality abstention gate

Tune N=1164, Holdout N=836. Top discriminating metrics: laplacianVariance, tenengrad.

| Split | recall (BAD_CAPTURE_RECALL) | precision | good-capture false-rejection |
|---|---|---|---|
| tune | 0.9763513513513513 | 0.993127147766323 | 0.006993006993006993 |
| holdout | 0.9952153110047847 | 0.985781990521327 | 0.014354066985645933 |

WRONG_RESULTS_SUPPRESSED on holdout BAD queries: 99.5%

## 06 — Visual-dominance guard threshold calibration

| Threshold | correct-TOP1 rescue rate | wrong-TOP1 false-high rate |
|---|---|---|
| 0.7 | 97.3% | 6.11% |
| 0.75 | 93.3% | 3.92% |
| 0.78 | 86.7% | 3.11% |
| 0.8 | 82.9% | 2.42% |
| 0.82 | 77.9% | 2.07% |
| 0.85 | 68.3% | 1.04% |
| 0.88 | 60% | 0.12% |
| 0.9 | 56.4% | 0.12% |
| 0.92 | 55.3% | 0% |
| 0.95 | 54.6% | 0% |

## 07 — Art-crop dual-score confusable-sibling discrimination (clean queries only)

Groups evaluated: 300, total queries: 1086

| Representation | TOP1-among-siblings |
|---|---|
| fullCardOnly | 100% |
| artCropOnly | 100% |
| dualAverage | 100% |
| dualMax | 100% |
