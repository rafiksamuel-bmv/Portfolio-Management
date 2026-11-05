-- History entries for the 20 September status deck.
--
-- Companion to 2026-09-20-deck-sync.sql, and OPTIONAL. That file set
-- companies.latest_status, which is the column the status deck prints. It is
-- not what the row detail panel shows: LATEST SITUATION is resolved by
-- latestSituation() from the newest history row for that company, so a deck
-- sync alone leaves the panel, and the morning deck's WHAT MOVED slide,
-- showing the previous entry.
--
-- This file logs each rewritten status as a history entry dated 20 September,
-- source 'Situation update' -- the same shape the situation box in "Edit
-- status & action" writes.
--
-- Only the nine companies whose LATEST STATUS cell was retyped in the deck are
-- here. Agel's text was shortened to "Pending updates from the company.",
-- which records no event; Bringy and Flash were not touched at all.
--
-- Each insert is guarded by `where not exists`, so re-running adds nothing.
-- There is deliberately no unique index on history (see CLAUDE.md), and
-- addHistory()'s near-duplicate warning does not apply to raw SQL, so the
-- guard is what stops a second run doubling the log.

begin;

insert into public.history (entry_date, company, entry, source)
select '2026-09-20', 'Amanleek', 'Company assessing feasibility of a holding company (~6 months). They no longer need us to convert.', 'Situation update'
where not exists (
  select 1 from public.history
  where company = 'Amanleek' and entry_date = '2026-09-20' and entry = 'Company assessing feasibility of a holding company (~6 months). They no longer need us to convert.');

insert into public.history (entry_date, company, entry, source)
select '2026-09-20', 'Belmazad', 'Pending updated legal review of ISV''s comments on their latest opinion. Our opinion is that considering 1) karvy valuation 2) accrued interest 3) avoidance of dilution during the extension period; we can accept the extension.', 'Situation update'
where not exists (
  select 1 from public.history
  where company = 'Belmazad' and entry_date = '2026-09-20' and entry = 'Pending updated legal review of ISV''s comments on their latest opinion. Our opinion is that considering 1) karvy valuation 2) accrued interest 3) avoidance of dilution during the extension period; we can accept the extension.');

insert into public.history (entry_date, company, entry, source)
select '2026-09-20', 'Connect Money', 'Misr Capital signed the confirmation that the note remains outstanding on 14 September. The board memo on non-conversion is ready to share with Misr Capital to schedule a board meeting. Waleed advised it must be approved at a scheduled board meeting, not by written circulation.', 'Situation update'
where not exists (
  select 1 from public.history
  where company = 'Connect Money' and entry_date = '2026-09-20' and entry = 'Misr Capital signed the confirmation that the note remains outstanding on 14 September. The board memo on non-conversion is ready to share with Misr Capital to schedule a board meeting. Waleed advised it must be approved at a scheduled board meeting, not by written circulation.');

insert into public.history (entry_date, company, entry, source)
select '2026-09-20', 'Flend', 'The board memo on the six-month extension has been shared with Misr capital and they returned with minor comments. Waleed advised it must be approved at a scheduled board meeting, not by written circulation. Team is prepping a recommendation to do a follow-on investment. Meeting is scheduled tentatively on the 4th of October with NBFI team to update status of credit facility, pending Flend to send Q2 financials.', 'Situation update'
where not exists (
  select 1 from public.history
  where company = 'Flend' and entry_date = '2026-09-20' and entry = 'The board memo on the six-month extension has been shared with Misr capital and they returned with minor comments. Waleed advised it must be approved at a scheduled board meeting, not by written circulation. Team is prepping a recommendation to do a follow-on investment. Meeting is scheduled tentatively on the 4th of October with NBFI team to update status of credit facility, pending Flend to send Q2 financials.');

insert into public.history (entry_date, company, entry, source)
select '2026-09-20', 'Seqoon', 'We had a call with seqoon and discussed our current concerns. The founders expressed willingness to buy our share of the company, which would result (at their current 7m valuation) in around 130k USD sale. We are scheduling another call this Tuesday to follow up on the discussion.', 'Situation update'
where not exists (
  select 1 from public.history
  where company = 'Seqoon' and entry_date = '2026-09-20' and entry = 'We had a call with seqoon and discussed our current concerns. The founders expressed willingness to buy our share of the company, which would result (at their current 7m valuation) in around 130k USD sale. We are scheduling another call this Tuesday to follow up on the discussion.');

insert into public.history (entry_date, company, entry, source)
select '2026-09-20', 'Settle', 'Call completed with Mr.Mohamed, roundtable prep in progress. Email send to Amr el Demerdash on Thursday and follow up due today', 'Situation update'
where not exists (
  select 1 from public.history
  where company = 'Settle' and entry_date = '2026-09-20' and entry = 'Call completed with Mr.Mohamed, roundtable prep in progress. Email send to Amr el Demerdash on Thursday and follow up due today');

insert into public.history (entry_date, company, entry, source)
select '2026-09-20', 'Subsbase', 'Call scheduled with the company on Tuesday 22nd of September. Counsel will be on call to support plan for liquidation process.', 'Situation update'
where not exists (
  select 1 from public.history
  where company = 'Subsbase' and entry_date = '2026-09-20' and entry = 'Call scheduled with the company on Tuesday 22nd of September. Counsel will be on call to support plan for liquidation process.');

insert into public.history (entry_date, company, entry, source)
select '2026-09-20', 'Unlock', 'Reem reminded the founders on 13 September to return the signed extension notice. The company has run out of cash and is no longer operational. Unlock has returned the signed extension', 'Situation update'
where not exists (
  select 1 from public.history
  where company = 'Unlock' and entry_date = '2026-09-20' and entry = 'Reem reminded the founders on 13 September to return the signed extension notice. The company has run out of cash and is no longer operational. Unlock has returned the signed extension');

insert into public.history (entry_date, company, entry, source)
select '2026-09-20', 'Zammit', 'Company is asking to make convertible note extension until end of year only, as founders are planning to shut down zammit in light of current agreement with Zid', 'Situation update'
where not exists (
  select 1 from public.history
  where company = 'Zammit' and entry_date = '2026-09-20' and entry = 'Company is asking to make convertible note extension until end of year only, as founders are planning to shut down zammit in light of current agreement with Zid');

commit;
