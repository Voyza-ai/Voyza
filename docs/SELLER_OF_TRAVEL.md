# Seller-of-Travel, ATOL & Package Travel: what applies to BlueMurr

> **RESEARCH, NOT LEGAL ADVICE.** Compiled 2026-11-02 from public statute, regulator and
> Duffel pages. Statutes and fees change; several official pages could not be fetched and are
> marked **unverified**. Get a travel-law attorney to confirm before taking live bookings.

**Scope.** BlueMurr is a US-based web app adding in-app flight booking through the Duffel
Orders API, using Duffel's accreditation ("Managed Content") and a Duffel-hosted card payment.
This covers US state seller-of-travel (SOT) laws, UK ATOL and Package Travel Regs, the EU
Package Travel Directive, what Duffel does and does not cover, and a pre-launch checklist.
Out of scope: tax (sales tax / VAT), money-transmitter licensing, insurance, non-flight
products other than hotel bundling.

---

## 0. Key findings (read first)

- **Using Duffel does not exempt BlueMurr from state SOT registration.** Duffel's services
  agreement makes each party warrant it holds "all licences ... necessary to offer the Travel
  Services" (cl. 2.4) and does not take on SOT, ATOL or package-travel duties for the seller
  ([Duffel Services Agreement](https://duffel.com/services-agreement)). Duffel's own guide says
  local licensing "can't be streamlined" and is the seller's job
  ([Duffel blog](https://duffel.com/blog/start-a-travel-business-regulations)).
- **The "air carrier" exemptions in CA/WA/FL/HI cover airlines, not resellers of airline
  tickets.** An online agency selling flights to residents is squarely a "seller of travel"
  in CA, FL and WA, and a "travel agency" (intermediary) in HI.
- **Registration is driven by where the customer lives, not where BlueMurr is.** CA, FL, WA
  (and HI in practice) reach out-of-state online sellers that sell to their residents.
- **Duffel Payments is not obviously "Duffel holds the money".** Duffel's Payment Intents
  docs say the customer's charge "will be added to your balance (minus any Duffel Payment
  fees)", and that Duffel is "currently not accepting new customers on to this product"
  ([Payment Intents API](https://duffel.com/docs/api/payment-intents)). Money landing in a
  balance BlueMurr controls may defeat the trust-account carve-outs in CA and WA (see §2).
  The alternative, Duffel **card** payments, makes the airline the merchant of record but
  leaves BlueMurr "contractually liable for any chargebacks or fraud"
  ([Duffel payments guide](https://duffel.com/guides/collecting-payments-from-your-customers)).
- **UK flight-only sales can likely ride Duffel's IATA accreditation under the airline-ticket-
  agent ATOL exemption** — but only if tickets issue immediately and the customer is told the
  flight is not ATOL-protected. Bundling hotels with flights (UK or EU) creates a *package*
  and needs ATOL / insolvency protection.

---

## 1. Which states have seller-of-travel laws (as of 2026-11-02)

| State | Status | Source |
|---|---|---|
| California | **Active** — registration with Attorney General | [CA AG Seller of Travel](https://oag.ca.gov/travel) |
| Florida | **Active** — registration + bond with FDACS | [FDACS Sellers of Travel](https://www.fdacs.gov/Business-Services/Sellers-of-Travel) |
| Washington | **Active** — licence with Dept. of Licensing | [RCW 19.138](https://app.leg.wa.gov/rcw/default.aspx?cite=19.138&full=true) |
| Hawaii | **Active** — registration with DCCA + client trust account | [HRS ch. 468L](https://data.capitol.hawaii.gov/hrscurrent/Vol10_Ch0436-0474/HRS0468L/HRS_0468L-.htm) |
| Iowa | **Repealed** (2020 Acts ch. 1103, eff. ~2020-07-01) | [Iowa Code ch. 9D listing](https://law.justia.com/codes/iowa/title-i/chapter-9d/) |
| Nevada | **Repealed** (2015 session) | [NV Consumer Affairs alert](https://consumeraffairs.nv.gov/Alerts/Other/Other) |
| Oregon | Likely repealed — 2009 SB 109 "repeals statutes governing sellers of travel" (passage **unverified**) | [OLIS SB 109](https://olis.oregonlegislature.gov/liz/2009R1/Measures/Overview/SB109) |
| Virginia | Travel-club law only; no general SOT registration found (**unverified**) | [travellaw.com FAQ](https://travellaw.com/faqs/faq/) |
| Delaware | Occupational licence only if you open an agency in DE; not an SOT registration (**unverified**, secondary source) | [Host Agency Reviews](https://hostagencyreviews.com/blog/travel-agent-license-seller-of-travel-license) |
| Maryland | Listed by one law firm as requiring registration — **unverified**, no official source found | [travellaw.com](https://travellaw.com/seller-of-travel-registration/) |

Several states (IL, LA, MA, MI, NY, PA, VA) have travel-specific consumer rules (disclosures,
travel clubs) without registration ([travellaw.com](https://travellaw.com/seller-of-travel-registration/)).

---

## 2. Active states: comparison

| | California | Florida | Washington | Hawaii |
|---|---|---|---|---|
| **Statute** | Bus. & Prof. Code §17550–17550.59 | Fla. Stat. §559.926–559.939 | RCW 19.138; WAC 308-129 | HRS 468L; HAR 16-116 |
| **Regulator** | Attorney General | FDACS | Dept. of Licensing | DCCA (PVL) |
| **Reaches out-of-state online sellers?** | Yes | Yes ("resident or nonresident") | Yes ("inside and outside the state") | Yes in practice (waiver exists for agencies "not physically located in Hawaii") |
| **Fee** | $100 per location/yr; late $5/day to $500 | $300/yr (cert. (a)); $1,000 / $2,500 for (b)/(c) | $222/yr (+$20 service-of-process per WAC, **unverified current**) | $138 biennial renewal (active); initial fee **unverified** |
| **Financial security** | Trust account **or** bond; card carve-out §17550.15(j) | Bond up to $25k (cert. (a)) | Trust account for funds held >5 business days, **or** $10k–$50k bond; card carve-out | Client trust account; waiver for card-only, pass-through sellers |
| **Show reg. no. in ads?** | Yes | Yes ("Fla. Seller of Travel Reg. No.") | Yes (except price-less "institutional" ads) | Not in statute (**unverified** in rules) |
| **Penalty** | Misdemeanor, ≤$10k and/or 1 yr per violation; felony tier for trust breaches | Admin fines ≤$5k per violation; each sale separate | Civil $500–$2k per violation; misdemeanor / gross misdemeanor; CPA violation | Fines ≤$1k per violation; trust-account breach = theft |

### California
- **Who.** A "seller of travel" is anyone who "sells, provides, furnishes, contracts for,
  arranges, or advertises" air or sea transportation, alone or with other services
  ([§17550.1 via FindLaw](https://codes.findlaw.com/ca/business-and-professions-code/bpc-sect-17550-1/)).
  Air carriers are excluded; "air carrier" means a DOT-certificated (or DOT-recognised foreign)
  operator ([§17550.4](https://codes.findlaw.com/ca/business-and-professions-code/bpc-sect-17550-4/)) —
  so this exclusion does **not** cover BlueMurr.
- **Out-of-state.** The law reaches sellers outside CA who sell to people in CA
  ([AB 2138 analysis, 2016](https://www.leginfo.ca.gov/pub/15-16/bill/asm/ab_2101-2150/ab_2138_cfa_20160622_151632_sen_floor.html)).
  Out-of-state sellers cannot join the Travel Consumer Restitution Fund (TCRF) and register
  only with the AG ([travellaw.com](https://travellaw.com/seller-of-travel-registration/california-seller-of-travel-registration/), secondary).
- **Registration.** Apply ≥10 days before doing business; $100 per location; renew yearly
  ([§17550.20](https://codes.findlaw.com/ca/business-and-professions-code/bpc-sect-17550-20/)).
  Registration number must appear on all advertising ([CA AG](https://oag.ca.gov/travel)).
- **Trust account / bond.** All customer payments go into a trust account
  ([§17550.15](https://codes.findlaw.com/ca/business-and-professions-code/bpc-sect-17550-15/)),
  or a bond under §17550.11 (§17550.15(k)). **Card carve-out (§17550.15(j)):** no trust
  deposit needed if paid by credit card, the seller does not "deposit, negotiate, or factor"
  the charge or obtain payment "to any account it controls", and the **carrier** processes the
  charge. Duffel card payments (airline = merchant of record) look like a fit; Duffel Payment
  Intents (funds to BlueMurr's Duffel Balance) probably do **not** — counsel to confirm.
- **Disclosures (§17550.13).** Before taking payment, written: seller name/address/phone,
  amounts, carrier and departure details, cancellation terms, the refund statement that
  sums paid for services not provided "will be promptly paid to the passenger", trust/bond
  status, and — for non-participants — that "the seller of travel is not a participant in the
  Travel Consumer Restitution Fund" ([FindLaw §17550.13](https://codes.findlaw.com/ca/business-and-professions-code/bpc-sect-17550-13/)).
- **Penalties.** Misdemeanor, ≤$10,000 and/or ≤1 year per violation; felony tier for trust
  violations ([§17550.19](https://codes.findlaw.com/ca/business-and-professions-code/bpc-sect-17550-19/)).
- Note: official leginfo pages returned 403 to the research tool; text taken from FindLaw and
  the AG's site. Confirm on [leginfo.legislature.ca.gov](https://leginfo.legislature.ca.gov).

### Florida
- **Who.** "Any resident or nonresident person ... that offers, directly or indirectly"
  prearranged travel; "offer for sale" includes a seller "who offers to sell to persons in
  Florida" ([§559.927](https://www.flsenate.gov/Laws/Statutes/2025/559.927)).
- **Fee and bond.** Annual registration $300 for certification (a) (no travel to "terrorist
  states" from FL), $1,000/(b), $2,500/(c); independent agents $50
  ([§559.928](https://www.flsenate.gov/Laws/Statutes/2025/559.928),
  [§559.9285](https://www.flsenate.gov/Laws/Statutes/2025/559.9285)). Bond up to $25,000
  ($50,000 with vacation certificates); waiver only after 5 compliant years
  ([§559.929](https://www.flsenate.gov/Laws/Statutes/2025/559.929)).
- **Exemptions** ([§559.935](https://www.flsenate.gov/Laws/Statutes/2025/559.935)): direct
  federally regulated carriers; hotels; and **sellers that directly issue airline tickets under
  their own ARC contract for ≥3 consecutive years** under the same ownership (annual
  certification still required). BlueMurr has no ARC contract of its own, so this exemption
  is not available; there is **no** exemption for not holding funds.
- **Disclosure.** Every ad, contract and travel document must say the firm "is registered with
  the State of Florida as a Seller of Travel. Registration No. ..." (§559.928(5); FDACS shows
  the short form "Fla. Seller of Travel Reg. No.") ([FDACS](https://www.fdacs.gov/Business-Services/Sellers-of-Travel)).
- **Penalties.** Fines up to $5,000 per violation; each sale or attempted sale can be a separate
  violation; cease-and-desist and injunctions ([FDACS](https://www.fdacs.gov/Business-Services/Sellers-of-Travel)).
- **Unverified:** whether FDACS treats an air-only online agency as selling "prearranged
  travel or tourist-related services". Large OTAs display FL registration numbers; assume yes.

### Washington
- **Who.** "A person, firm, or corporation both inside and outside the state" that transacts
  business with Washington consumers by directly offering or selling travel services; air
  carriers (and affiliates selling only that carrier) excluded
  ([RCW 19.138.021](https://app.leg.wa.gov/RCW/default.aspx?cite=19.138.021)).
- **Registration.** Required before selling or advertising; number in all advertising except
  institutional ads; renew annually ([RCW 19.138.100–.120](https://app.leg.wa.gov/rcw/default.aspx?cite=19.138&full=true)).
  Fee $222 main / $222 branch ([DOL fees](https://dol.wa.gov/professional-licenses/sellers-travel/fees-sellers-travel)).
- **Trust account.** Funds held more than 5 business days go into a WA trust account
  (out-of-state account allowed only with >$5M WA sales); **card carve-out** where the seller
  does not deposit or control the charge and the carrier/provider processes it; or a
  $10k–$50k bond instead ([RCW 19.138.140](https://app.leg.wa.gov/rcw/default.aspx?cite=19.138.140)).
- **Disclosures.** At or before payment (within 3 business days for remote sales): name,
  address, phone, amount, **registration number**, vendor details, cancellation-penalty
  advisory, refund statement in 8-pt bold (RCW 19.138.040). Refunds within 30 days of receiving
  vendor funds, 14 days if never sent (RCW 19.138.050).
- **Penalties.** Civil $500–$2,000 per violation (19.138.240); misdemeanor / gross misdemeanor
  (19.138.270); also a Consumer Protection Act violation (19.138.290).

### Hawaii
- **Who.** "Travel agency" = anyone who for compensation "acts or attempts to act as an
  intermediary" selling travel services incl. air transport; air carriers excluded only for
  their own services ([HRS 468L-1](https://data.capitol.hawaii.gov/hrscurrent/Vol10_Ch0436-0474/HRS0468L/HRS_0468L-0001.htm)).
  Must register before selling or advertising ([468L-2](https://data.capitol.hawaii.gov/hrscurrent/Vol10_Ch0436-0474/HRS0468L/HRS_0468L-0002.htm)).
  The statute has no explicit out-of-state clause, but DCCA runs a waiver for agencies "not
  physically located in Hawaii", which implies they register
  ([DCCA Travel Agency Program](https://cca.hawaii.gov/pvl/programs/travel/)).
- **Fees.** Renewal $138 (active) every odd-numbered year; DCCA page shows conflicting renewal
  dates — confirm with DCCA. Initial application fee **unverified** (a secondary source cites
  $215 even / $146 odd years).
- **Client trust account** at a Hawaii-insured bank within 5 business days of receipt
  ([468L-5](https://data.capitol.hawaii.gov/hrscurrent/Vol10_Ch0436-0474/HRS0468L/HRS_0468L-.htm)).
  **Waiver** for an agency that is not in Hawaii, takes no cash/checks, takes only card or
  electronic payments, and "pays all received funds directly to the travel providers or
  facilitator" ([DCCA](https://cca.hawaii.gov/pvl/programs/travel/)) — BlueMurr would likely
  qualify; Duffel is plausibly the "facilitator" (**unverified**).
- **Disclosure** at payment: agency details, amounts, trust-account bank, supplier,
  restrictions and cancellation terms ([468L-4](https://data.capitol.hawaii.gov/hrscurrent/Vol10_Ch0436-0474/HRS0468L/HRS_0468L-0004.htm)).
- **Penalties.** Up to $1,000 per violation, summary suspension and account freeze
  (468L-5.6); knowingly breaching trust rules is theft (468L-12).

### Iowa / Nevada (for completeness)
- Iowa ch. 9D (register if soliciting Iowa residents, bond, annual fee) was repealed by 2020
  Acts ch. 1103 ([Justia listing](https://law.justia.com/codes/iowa/title-i/chapter-9d/)).
- Nevada repealed SOT registration in the 2015 session
  ([NV Consumer Affairs](https://consumeraffairs.nv.gov/Alerts/Other/Other)); the notice cites
  NRS 597/599B while SOT rules sat in NRS 598, so the exact repealed sections are **unverified**.
- Neither currently requires registration; general consumer-protection law still applies.

---

## 3. UK: ATOL and the Package Travel Regulations 2018

**Who needs an ATOL.** Under the ATOL Regulations 2012 a person must not "in the United Kingdom
make available flight accommodation" unless it is the aircraft operator, an ATOL holder, or
exempt ([reg. 9](https://www.legislation.gov.uk/uksi/2012/1017/regulation/9)).

**Flight-only — exemptions relevant to BlueMurr**
([CAA: Selling Flight-Only](https://www.caa.co.uk/atol-protection/trade/air-travel-organisers-licensing-atol/selling-flight-only/);
[CAA: Airline ticket agents](https://www.caa.co.uk/atol-protection/atol-compliance/requirements-legal-obligations/airline-ticket-agents/)):
- **Airline ticket agent / IATA-accredited agent.** Exempt if: appointed by the airline (IATA
  agents with ticketing authority need no separate written agreement); deals directly with
  consumers; **issues confirmed tickets immediately on payment**; tells the consumer it is an
  airline ticket agent for the named airline(s) and **the flight is not ATOL-protected**; and
  the ticket is not part of a package. The CAA says this can apply "whether established
  inside or outside the UK".
- **Duffel route.** Duffel states UK flight-only sellers "can leverage the IATA accreditation of
  Duffel as an exemption from ATOL" ([Duffel blog](https://duffel.com/blog/start-a-travel-business-regulations)).
  The conditions above still apply; whether a sub-seller on Duffel's IATA number meets
  "appointed by the airline" is Duffel's position, not a CAA ruling (**unverified**).
- **Selling as principal** (taking the money and then buying the seat, delayed ticketing, or
  holding orders and paying later) requires your own ATOL unless another exemption applies.
- **Agent for an ATOL holder.** Possible: exempt if, on receiving payment, the agent can issue
  the ATOL Certificate on the holder's behalf, bind the holder, and acts under a compliant
  written agency agreement (ATOL Regs reg. 10/reg. 22 as summarised by the CAA). Duffel's
  agreement does not mention ATOL, so **Duffel is not an ATOL holder for BlueMurr** on current
  evidence ([Services Agreement](https://duffel.com/services-agreement)).
- **Overseas exemption.** A CAA exemption has covered flights whose first leg starts outside
  the UK (other than Ireland); current status **unverified**.

**Packages / "Flight-Plus".** Since the 2018 reforms the old "Flight-Plus" category was folded
into flight-inclusive packages (**unverified** wording; see CAA ORS3). Any flight sold with
another travel service as a package needs an ATOL, and the consumer must get an **ATOL
Certificate** at payment ([CAA Selling Flight-Only](https://www.caa.co.uk/atol-protection/trade/air-travel-organisers-licensing-atol/selling-flight-only/)).
Per-passenger ATOL Protection Contribution amount: **unverified**.

**Package Travel and Linked Travel Arrangements Regulations 2018**
([SI 2018/634](https://www.legislation.gov.uk/uksi/2018/634/regulation/2)):
- *Package* = at least two types of travel service for the same trip combined by one trader,
  sold from a single point of sale and chosen before payment, sold at an inclusive price,
  advertised as a package, or booked via linked online processes where the traveller's data
  is passed and the second contract is concluded within 24 hours.
- *Linked travel arrangement (LTA)* = separate contracts where the trader facilitates separate
  selection and payment in one visit, or targeted procurement of another service within 24 hours.
- Organisers are liable for performance of the whole package and must protect payments against
  insolvency (ATOL for flight-inclusive packages).

---

## 4. EU Package Travel Directive (EU) 2015/2302

Source: [EUR-Lex 32015L2302](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32015L2302)
(article text read via [legislation.gov.uk mirror](https://www.legislation.gov.uk/eudr/2015/2302/contents)).
- **Travel services** (Art. 3(1)): carriage of passengers; accommodation; car/motorcycle
  rental; other tourist services ([Art. 3](https://www.legislation.gov.uk/eudr/2015/2302/article/3)).
- **Flight-only is not covered.** Packages and LTAs both need at least two *different* types
  of travel service (Arts. 2–3). A single flight sale, even multi-city, is outside the Directive
  (it is covered by passenger-rights rules such as Reg. 261/2004, not researched here).
- **Packages vs LTAs.** Same tests as the UK rules above (the UK copied the Directive). An
  organiser is liable for performance of all services (Art. 13) and must have insolvency
  protection (Art. 17). A trader facilitating LTAs must protect payments it receives and give
  a prescribed information form; if it fails, package rights apply (Art. 19,
  [Ch. VI](https://www.legislation.gov.uk/eudr/2015/2302/chapter/VI)).
- **Non-EU organisers.** Organisers "not established in a Member State which sell or offer
  for sale packages in a Member State" must provide security under that state's law
  ([Art. 17](https://www.legislation.gov.uk/eudr/2015/2302/article/17)); EU retailers selling a
  non-EEA organiser's packages take on organiser duties ([Art. 20](https://www.legislation.gov.uk/eudr/2015/2302/article/20)).
  Exact "directs activities to" test for a US website: **unverified** — national implementing laws differ.
- **Relevance to BlueMurr.** Flight + hotel for the same trip, chosen in one checkout, or sold
  at a single price = **package**; BlueMurr becomes the organiser. Showing hotel links after a
  flight booking, or passing traveller data to a hotel booking within 24 h, may create an
  **LTA** or even a package. Decide the product design before bundling.

---

## 5. What Duffel covers — and what it does not

| Area | Duffel covers? | Evidence |
|---|---|---|
| IATA / ARC accreditation and ticketing authority | **Yes**, via Managed Content: Duffel "acts as your licensed travel agent" under its (or a partner's) IATA/ARC accreditation; US entity may be Duffel Travel US Inc. | [Services Agreement cl. 14.1](https://duffel.com/services-agreement); [Help: ARC/IATA](https://help.duffel.com/hc/en-gb/articles/360019644700-Do-I-need-to-be-an-ARC-IATA-travel-agent) |
| Ticket issuance and airline servicing | **Yes** (second-line support with airlines) | Services Agreement cl. 14.3 |
| Contract of carriage | Between **traveller and airline** | cl. 3.3 |
| Card payment — Duffel card flow | Card passed to airline; **airline is merchant of record**; Duffel moves no funds | [Duffel payments guide](https://duffel.com/guides/collecting-payments-from-your-customers) |
| Card payment — Payment Intents ("Duffel Payments", Stripe) | Charge is added to **your Duffel Balance** minus fees; refunds against the intent; default max £5,000; **closed to new customers** | [Payment Intents API](https://duffel.com/docs/api/payment-intents); cl. 16 |
| Merchant of record under Payment Intents | **Not stated** in the docs we could read (help-centre MoR article not retrievable) — **unverified** | — |
| Chargebacks and fraud | **No** — seller is "contractually liable for any chargebacks or fraud"; Fines (incl. chargebacks) recoverable from your Balance/card | [payments guide](https://duffel.com/guides/collecting-payments-from-your-customers); cl. 4.5, 7.1A |
| Refund timing | **No control** — refunds follow airline policy; Duffel refunds Balance only after the airline pays | cl. 4.5, 5.1 |
| Customer contact / confirmations | **No** — "Duffel will never contact your customers directly" | [Help article](https://help.duffel.com/hc/en-gb/articles/360021076679-Will-Duffel-ever-contact-my-customers) |
| KYC | Duffel runs KYC **on BlueMurr** (cl. 1.1), not on travellers | cl. 1.1 |
| Supplier T&Cs shown to traveller | **Seller's duty** — must be "prominently and accurately displayed" and accepted before order | cl. 3.3 |
| State SOT registration | **No** — seller warrants its own licences | cl. 2.4; [Duffel blog](https://duffel.com/blog/start-a-travel-business-regulations) |
| ATOL / package travel | **Not mentioned** in agreement; Duffel's IATA status is only an *exemption route* for UK flight-only | Services Agreement; Duffel blog |
| Price display to travellers | **Silent** — seller's job; Duffel not liable for price discrepancies | cl. 5.4 |

**Implication.** Under Payment Intents, BlueMurr arguably *does* receive customer funds
(into a Balance it controls), which matters for the CA/WA card carve-outs and the HI waiver.
Under the card flow, the airline charges the card directly (good for the carve-outs) but
BlueMurr can only add its own markup/fee via a separate charge, which it would then hold.
Ask Duffel in writing: (1) who is MoR and what descriptor appears on the statement under
each flow; (2) whether Payment Intents is available to BlueMurr; (3) which Duffel entity is
the US agent of record.

---

## 6. US federal rules that apply regardless of state registration

- **Full-fare advertising — 14 CFR 399.84.** Any price shown by a carrier **or ticket agent**
  must be "the entire price to be paid by the customer"; government taxes may be itemised but
  not more prominent than, or the same size as, the total
  ([14 CFR 399.84](https://www.law.cornell.edu/cfr/text/14/399.84)). Applies to search results,
  map cards and AI-generated price mentions.
- **2024 refund rule.** DOT's April 2024 final rule (14 CFR part 260 and amended part 399)
  requires **ticket agents that are merchants of record** to give prompt refunds when due —
  7 business days for card purchases, 20 days otherwise; compliance date 2024-10-28
  ([Federal Register](https://www.federalregister.gov/documents/2024/04/26/2024-07177/refunds-and-other-consumer-protections);
  [small-business guide](https://www.transportation.gov/sites/dot.gov/files/2024-12/Refund%20Final%20Rule%20Small%20Business%20Compliance%20Guidance.pdf)).
  MoR = whoever appears on the card statement. If the airline is MoR (Duffel card flow) the
  airline refunds the fare; BlueMurr still owes refunds of its own fees. A 2025 DOT notice
  paused enforcement for some codeshare cases until 2026-06-30
  ([public inspection 2025-22140](https://public-inspection.federalregister.gov/2025-22140.pdf));
  current status **unverified**.
- Other ticket-agent rules (code-share disclosure, baggage-fee disclosure, unfair/deceptive
  practices under 49 U.S.C. 41712) were not researched in depth — **unverified** scope.

---

## 7. What BlueMurr must do before going live

Priority order. "P0" = blocker for taking a real payment from a US customer.

**P0 — before the first live booking**
1. **Engage a US travel-law attorney** to confirm this memo, especially SOT applicability to an
   air-only, Duffel-ticketed seller and the trust-account position under each Duffel payment flow.
2. **Confirm the Duffel payment flow in writing** (card vs Payment Intents; MoR; statement
   descriptor; chargeback handling; availability). Design the money flow so customer funds go
   straight to the carrier where possible.
3. **Register in California** (AG, ≥10 days before selling; $100/location) and decide trust
   account vs bond vs §17550.15(j) card carve-out; prepare the §17550.13 disclosures incl.
   "not a participant in the Travel Consumer Restitution Fund".
4. **Register in Florida** (FDACS, $300 + up to $25k bond). No ARC exemption available.
5. **License in Washington** (DOL, $222) and confirm trust-account carve-out or bond.
6. **Register in Hawaii** (DCCA) and apply for the client-trust-account waiver.
   *Alternative to 3–6:* block bookings from residents of CA/FL/WA/HI until registered
   (geo/billing-address gate) — confirm with counsel that this is sufficient.
7. **Display registration numbers** on the site footer, checkout, confirmations and ads
   (CA, FL "registered with the State of Florida as a Seller of Travel. Registration No. ...",
   WA).
8. **Full-fare price display (14 CFR 399.84):** every displayed fare is the all-in per-person
   total including taxes, carrier fees and BlueMurr's markup/service fee.
9. **Terms & conditions + checkout disclosures:** BlueMurr acts as agent; contract of carriage
   is with the airline; show airline fare rules/conditions and get acceptance before ordering
   (Duffel cl. 3.3); cancellation/change penalties; who refunds what and when.
10. **Refund operations:** process to refund BlueMurr's own fees within DOT timelines and pass
    through airline refunds (WA: 30 days after receipt; CA: "promptly").
11. **Booking confirmation emails** from BlueMurr with the state-required content (WA within
    3 business days; HI/CA at payment), PNR, and support contact — Duffel will not send these.
12. **Chargeback/fraud plan:** BlueMurr is liable; set fraud screening and a dispute process.

**P1 — soon after launch**
13. **Privacy policy and data handling** for passenger data (names, DOB, passport, contact)
    shared with Duffel and airlines; check state privacy laws (e.g. CCPA/CPRA) — not researched here.
14. **Customer support** coverage (first-line is BlueMurr's) and a schedule-change process.
15. Track renewals: CA annual, FL annual, WA annual (by July 1 or as set), HI odd-year.

**P2 — before expanding scope**
16. **UK sales:** decide ATOL position first. Flight-only via Duffel IATA + immediate ticketing
    + "not ATOL-protected" notice; no hold-and-pay-later for UK customers; get Duffel to confirm.
17. **Bundling hotels with flights (any market):** decide package vs LTA vs separate bookings
    *before* building the checkout. A package means ATOL (UK), insolvency protection (EU),
    organiser liability, and likely CA/FL/WA treatment as a fuller seller of travel.
18. **EU sales:** flight-only is outside the PTD; packages to EU travellers need insolvency
    protection under the target member state's law (Art. 17).

---

## 8. Open questions (unverified)

- Merchant of record and card-statement name under Duffel Payment Intents.
- Whether Payment Intents is still closed to new Duffel customers.
- Whether FDACS treats air-only online booking as "prearranged travel" (assume yes).
- Hawaii initial registration fee and current renewal cycle (DCCA page is inconsistent).
- Maryland, Oregon, Virginia, Delaware status — no official confirmation found.
- Whether Duffel's IATA number satisfies the CAA "appointed by the airline" condition for a sub-seller.
- Current status of the DOT 2025 enforcement pause on refund rules.
