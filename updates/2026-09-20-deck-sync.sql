-- Sync the tracker with the status deck edited on 20 September 2026
-- (portfolio-status-2026-09-20.pptx, revision 2, edited in PowerPoint).
--
-- The deck's DETAILED STATUS table maps onto four company columns:
--   ISSUE CURRENTLY ADDRESSED -> issue_title
--   LATEST STATUS             -> latest_status
--   TARGETED OUTCOME          -> closure   (labelled "Strategic Target")
--   PRIORITY                  -> priority
-- The deck carried no ACTION MAP slide, so next_action is left untouched.
--
-- Run it by pasting the whole file into the Supabase SQL editor. It is one
-- transaction, so a mistake anywhere rolls the lot back and nothing is half
-- applied. Nothing in the app needs redeploying: the page refetches on the
-- realtime event, and the 7am deck reads the same rows.
--
-- Safe to re-run: every statement is an unconditional set to the deck's value.
-- companies_touch keeps updated_at honest; last_updated is the date shown in
-- the tracker's Updated column, so it is set with them.

begin;

update public.companies set
  issue_title   = 'No critical issue ongoing',
  latest_status = 'Pending updates from the company.',
  closure       = 'Support the company where we can.',
  priority      = 'No Action',
  last_updated  = '2026-09-20'
where id = 'co1';  -- Agel

update public.companies set
  issue_title   = 'Securing conversion on preferred shares.',
  latest_status = 'Company assessing feasibility of a holding company (~6 months). They no longer need us to convert.',
  closure       = 'Execute the final decision whether to convert at maturity or wait until there is a round.',
  priority      = 'Near-Term',
  last_updated  = '2026-09-20'
where id = 'co2';  -- Amanleek

update public.companies set
  issue_title   = 'Reviewing the request to extend the note from Dec 2026 to Aug 2027.',
  latest_status = 'Pending updated legal review of ISV''s comments on their latest opinion. Our opinion is that considering 1) karvy valuation 2) accrued interest 3) avoidance of dilution during the extension period; we can accept the extension.',
  closure       = 'Complete the legal review and align with Misr Capital, then decide the extension and communicate it to the company.',
  priority      = 'Immediate',
  last_updated  = '2026-09-20'
where id = 'co3';  -- Belmazad

update public.companies set
  issue_title   = 'No critical issue ongoing.',
  latest_status = 'Extension letter signed on our side and sent on 14 September, awaiting the company''s signature.',
  closure       = 'Support the company where we can.',
  priority      = 'No Action',
  last_updated  = '2026-09-20'
where id = 'co4';  -- Bringy

update public.companies set
  issue_title   = 'Finalizing transfer from Misr Capital to MFI.',
  latest_status = 'Misr Capital signed the confirmation that the note remains outstanding on 14 September. The board memo on non-conversion is ready to share with Misr Capital to schedule a board meeting. Waleed advised it must be approved at a scheduled board meeting, not by written circulation.',
  closure       = 'Complete the transfer from Misr Capital, then support the company commercially, starting with banking services for the credit facility.',
  priority      = 'Immediate',
  last_updated  = '2026-09-20'
where id = 'co5';  -- Connect Money

update public.companies set
  issue_title   = 'No critical issue ongoing.',
  latest_status = null,
  closure       = 'Support the company where we can.',
  priority      = 'No Action',
  last_updated  = '2026-09-20'
where id = 'co6';  -- Flash

update public.companies set
  issue_title   = 'Extending the convertible note. And considering doing a follow-on',
  latest_status = 'The board memo on the six-month extension has been shared with Misr capital and they returned with minor comments. Waleed advised it must be approved at a scheduled board meeting, not by written circulation. Team is prepping a recommendation to do a follow-on investment. Meeting is scheduled tentatively on the 4th of October with NBFI team to update status of credit facility, pending Flend to send Q2 financials.',
  closure       = 'Convert on the round closing before year end and then work on development of ring-fenced credit facility.',
  priority      = 'Immediate',
  last_updated  = '2026-09-20'
where id = 'co7';  -- Flend

update public.companies set
  issue_title   = 'Claimed qualified equity financing.',
  latest_status = 'We had a call with seqoon and discussed our current concerns. The founders expressed willingness to buy our share of the company, which would result (at their current 7m valuation) in around 130k USD sale. We are scheduling another call this Tuesday to follow up on the discussion.',
  closure       = 'Negotiate an exit, pending finalizing our decision.',
  priority      = 'Immediate',
  last_updated  = '2026-09-20'
where id = 'co8';  -- Seqoon

update public.companies set
  issue_title   = 'Organizing roundtable between the company and large corporate CFOs',
  latest_status = 'Call completed with Mr.Mohamed, roundtable prep in progress. Email send to Amr el Demerdash on Thursday and follow up due today',
  closure       = 'Support the company through client onboarding, help secure SWIFT.',
  priority      = 'Near-Term',
  last_updated  = '2026-09-20'
where id = 'co9';  -- Settle

update public.companies set
  issue_title   = 'Securing our rights during the liquidation process.',
  latest_status = 'Call scheduled with the company on Tuesday 22nd of September. Counsel will be on call to support plan for liquidation process.',
  closure       = 'Secure our rights during liquidation process.',
  priority      = 'Immediate',
  last_updated  = '2026-09-20'
where id = 'co10';  -- Subsbase

update public.companies set
  issue_title   = 'No critical issue ongoing',
  latest_status = 'Reem reminded the founders on 13 September to return the signed extension notice. The company has run out of cash and is no longer operational. Unlock has returned the signed extension',
  closure       = 'Support the company where we can.',
  priority      = 'No Action',
  last_updated  = '2026-09-20'
where id = 'co11';  -- Unlock

update public.companies set
  issue_title   = 'Assessing redraft of restructure agreement and company’s request to make the extension until end of the year.',
  latest_status = 'Company is asking to make convertible note extension until end of year only, as founders are planning to shut down zammit in light of current agreement with Zid',
  closure       = 'Secure the signed extension, after review of the company’s current request, then finalize the restructuring agreement in light of the Zid acquihire.',
  priority      = 'Immediate',
  last_updated  = '2026-09-20'
where id = 'co12';  -- Zammit

commit;
