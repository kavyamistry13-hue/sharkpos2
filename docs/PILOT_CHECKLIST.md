# SHARKPOS 2 — Sprint 6: real-store pilot (5 kirana / grocery / general stores)

Purpose: learn what shop owners actually use, ignore, trust and reject, before building anything else.
Rule: **no new feature is built because it can be imagined. Only repeated pilot evidence (2+ shops, or one shop blocked) justifies a change.**
No deployment, payment or paid service is part of this checklist. Run it on whatever environment the owner approves.

## Before the pilot (per shop)
- [ ] Shop type, size, number of staff, current tool (notebook / Excel / other POS): ______
- [ ] Owner agrees to share usage notes; no customer personal data is copied out of the system.
- [ ] Products, prices, stock and suppliers loaded (note who did it and how long it took).
- [ ] Owner, manager and cashier accounts created; each person logged in once.
- [ ] Owner told plainly: recommendations are rule-based, not AI, and "value" is counted only from their own records.

## Week 0–1 — onboarding (log minutes and blockers)
| Item | Minutes | Stuck? | Notes |
|---|---|---|---|
| Register / login | | | |
| Add products (how many, how) | | | |
| First sale | | | |
| Add supplier + first purchase order | | | |
| First udhaar customer + limit | | | |

## Daily log (one row per shop per day; 2 minutes at close)
| Date | Bills in SHARKPOS | Bills still on paper | Udhaar entries | Shift opened/closed? | Cash counted? | Action Center opened? | Recs accepted / rejected | Mistakes / confusion |
|---|---|---|---|---|---|---|---|---|

## Usage questions (ask at day 3, day 7, day 14)
- **POS:** how many of today's sales went through it? What made staff use paper instead?
- **Purchasing:** did they raise a PO? Receive goods in the system? Compare supplier prices?
- **Udhaar:** is every credit sale entered? Did they use the WhatsApp reminder? Did anyone pay after a reminder?
- **Closing / shifts:** did the cashier close a shift? Was the cash variance believable? Who reads the closing report?
- **Action Center:** opened how often? Which recommendations did they act on? Which were ignored, and why?
- **Value & ROI:** do they understand "pending / verified / not measurable"? Do they believe the numbers?

## Recommendation trust log (copy from the app's decisions list)
| Shop | Recommendation | Accepted / rejected / ignored | Their reason | What they actually did (even outside the app) | Outcome observed |
|---|---|---|---|---|---|

## Things done outside the system (the most valuable column)
List every workaround: notebook entries, WhatsApp messages, phone calls, spreadsheets, handwritten counts.

## Problems and requests
| Shop | Confusing screen | Missing feature | Requested improvement | Seen in how many shops? |
|---|---|---|---|---|

## Pricing feedback (ask only after day 10)
- Would you pay for this? [ ] yes [ ] maybe [ ] no — why: ______
- What would you pay per month, and what would make it clearly worth it? ______
- What would you stop using it for first if the price went up? ______
- Would you recommend it to another shopkeeper? ______

## Pilot exit scorecard (per shop, day 14–30)
| Measure | Result |
|---|---|
| % of sales through POS | |
| Udhaar kept in system (yes / partly / no) | |
| Shifts closed on days worked | |
| Recommendations accepted / rejected / ignored | |
| Verified value (₹) and pending outcomes | |
| Worst usability problem | |
| Would pay? / price said | |

## After the pilot
1. Tally problems by number of shops. Only problems seen in 2+ shops (or blocking daily work) become Sprint 7 candidates.
2. Review rejected recommendations: wrong rule, wrong threshold, or wrong wording?
3. Compare "verified value" with what owners say they gained. Differences show where measurement is missing.
4. Decide go / change / stop per module (POS, purchasing, udhaar, closing, Action Center, Value).
