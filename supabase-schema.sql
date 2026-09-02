-- BMV Portfolio Ledger — Supabase schema and seed
-- Run this once in the Supabase SQL editor (Database > SQL Editor > New query).

-- ---------- 1. tables ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  email        text,
  display_name text,
  role         text not null default 'Analyst'
                 check (role in ('Analyst','Manager','Legal','Head','Chief Venture Officer')),
  created_at   timestamptz not null default now()
);

create table if not exists public.companies (
  id              text primary key,
  num             int,
  company         text not null,
  instrument      text,
  bucket          text,
  ccy             text,
  invested        numeric,
  cap             numeric,
  discount        numeric,
  payment_date    date,
  maturity_date   date,
  extended_to     date,
  next_trigger    text,
  trigger_basis   text,
  status          text,
  issue_type      text,
  priority        text,
  next_action     text,
  owner           text,
  due             text,
  legal_next      text,
  legal_req       text,
  target_feedback text,
  vc_track        text,
  vc_plan         text,
  last_updated    date,
  legal_raised_at timestamptz,
  updated_at      timestamptz not null default now(),
  updated_by      text
);

create table if not exists public.history (
  id         uuid primary key default gen_random_uuid(),
  entry_date date not null,
  company    text,
  entry      text not null,
  source     text,
  created_at timestamptz not null default now(),
  created_by text
);

create table if not exists public.messages (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  seat       text,
  author_id  uuid references auth.users on delete set null,
  company_id text references public.companies on delete cascade,
  body       text not null
);

-- key/value for the Legend lists, FX rate, deck figures and the standing note
create table if not exists public.settings (
  key   text primary key,
  value jsonb not null
);

-- ---------- 2. keep updated_at honest ----------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists companies_touch on public.companies;
create trigger companies_touch before update on public.companies
  for each row execute function public.touch_updated_at();

-- ---------- 3. row level security ----------
-- Everyone who can sign in is an editor, matching how the team works today.
alter table public.profiles  enable row level security;
alter table public.companies enable row level security;
alter table public.history   enable row level security;
alter table public.messages  enable row level security;
alter table public.settings  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['companies','history','messages','settings'] loop
    execute format('drop policy if exists read_all on public.%I', t);
    execute format('drop policy if exists write_all on public.%I', t);
    execute format('create policy read_all  on public.%I for select to authenticated using (true)', t);
    execute format('create policy write_all on public.%I for all    to authenticated using (true) with check (true)', t);
  end loop;
end $$;

drop policy if exists profiles_read on public.profiles;
drop policy if exists profiles_self on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (true);
create policy profiles_self on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- ---------- 4. create a profile row on sign up ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 5. realtime (safe to re-run) ----------
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array['companies','history','messages','settings'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- 6. seed: the 12 tracker rows ----------

insert into public.companies (id,num,company,instrument,bucket,ccy,invested,cap,discount,payment_date,maturity_date,extended_to,next_trigger,trigger_basis,status,issue_type,priority,next_action,owner,due,legal_next,legal_req,target_feedback,vc_track,vc_plan,last_updated,legal_raised_at) values
('co1', 1, 'Agel', 'CN', 'Watchlist', 'USD', 125000.0, 4800000.0, 0.2, '2023-06-14', '2025-06-14', null, 'Maturity', 'QEF USD 1.0m; Target Financing USD 1.0m; 24m from payment', 'Pending company', 'Investment Issue', 'No Action', '• Review the business plan once the company shares it.', 'Reem', '30 Sep 2026', 'NO', null, null, 'Business model & market study', 'Review the business case upoin sharing', '2026-08-30', null),
('co2', 2, 'Amanleek', 'CN', 'Stable', 'USD', 125000.0, 3000000.0, 0.2, '2023-06-14', '2025-06-14', null, 'Maturity', 'QEF USD 2.0m; Target Financing USD 10.0m; 24m from payment', 'Pending company', 'Investment & Legal', 'Immediate', '• Press for a firm issuance timeline so the year-end FRA deadline is met.
• Decide whether to extend the note, or confirm why an extension is not required here.', 'Reem', '31 Dec 2026 (FRA)', 'NO', null, null, 'Banking services', 'We have shared a payroll offer', '2026-08-30', null),
('co3', 3, 'Belmazad', 'CLN', 'Stable', 'EGP', 14000000.0, 114000000.0, 0.3, '2024-12-27', '2026-12-27', null, 'Maturity', 'Equity Financing EGP 19.0m; cap EGP 114.0m pre-money; maturity 24m from first drawdown (date not recorded)', 'Pending legal', 'Investment & Legal', 'Near-Term', '• Follow up for Shawarby''s advice.
• Decide whether to approve the extension once legal input is received.', 'Mina', '30 Sep 2026', 'YES', 'Get feedback on the implication of the extension (already sent by Mina to Shawarby and follow up sent on the 30th of August).', '2 working days (End of 31st)', 'Venture clienting', 'Hold until the extension decision is made. But later on, considering that Belmazad is a good venture clienting case, discuss with company how to keep the venture clienting process operational and expand on it.', '2026-08-30', '2026-08-30T09:00:00.000Z'),
('co4', 4, 'Bringy', 'CN', 'Watchlist', 'USD', 125000.0, 6000000.0, 0.2, '2023-06-14', '2025-06-14', null, 'Maturity', 'QEF USD 2.0m; Target Financing USD 10.0m; 24m from payment', 'Pending company', 'Investment Issue', 'No Action', '• No action required; continue quarterly monitoring.', 'Rafik', '31 Oct 2026 (Q3)', 'NO', null, null, 'None currently', null, '2026-08-30', null),
('co5', 5, 'Connect Money', 'SAFE', 'Growing', 'USD', 1000000.0, 15000000.0, 0.5, '2024-07-31', '2026-07-31', null, 'Maturity', 'Matured 31 Jul 2026. Section 1(e): converts on written demand by the Investor OR the Majority-in-Interest, at the Safe Price (cap / Company Capitalization) with NO discount. The SAFE contains no extension mechanism; if no demand is made it simply stays outstanding. Section 1(a) Equity Financing conversion instead gives the BETTER of Safe Price or a 50% discount to the round price. SAFE-2 issues SAFEs, not Preferred Shares at a fixed pre-money valuation, so it may not itself trigger 1(a).', 'Pending legal', 'Investment & Legal', 'Immediate', 'Confirm dilution and share price calculation', 'Rafik', '31 Aug 2026', 'YES', 'Confirm how our share is currently calculated', '2 working days', 'Banking services', 'Support company in credit facility', '2026-08-30', '2026-08-30T09:00:00.000Z'),
('co6', 6, 'Flash', 'SHA', 'Stable', 'USD', 125000.0, null, null, '2024-02-28', null, null, null, null, 'On track', 'No Issue', 'No Action', '• Continue monitoring information rights and governance compliance.', 'Rafik', '31 Oct 2026', 'NO', null, null, 'None currently', null, '2026-08-30', null),
('co7', 7, 'Flend', 'CN', 'Growing', 'USD', 125000.0, 6000000.0, 0.2, '2024-02-28', '2026-02-28', '2026-08-28', 'Financing round', 'QEF USD 2.0m; Target Financing USD 3.0m; 24m from payment', 'Pending legal', 'Investment & Legal', 'Immediate', '• Obtain Misr Capital''s rationale for the three-month term, then decide the extension length.', 'Reem', '15 Sep 2026', 'YES', 'Get feedback on the implication of the extension (as per the details shared with Mina earlier by email).', '1 working day', 'Banking services', 'Suppot in credit facility and develop data sharing mechanism to develop ring fenced credit facility', '2026-08-30', '2026-08-30T09:00:00.000Z'),
('co8', 8, 'Seqoon', 'CN', 'Pivoting', 'USD', 125000.0, 6000000.0, 0.2, '2023-06-14', '2025-06-14', null, 'Financing round', 'QEF USD 1.0m; Target Financing USD 3.0m; claimed financing USD 750k cash + USD 250k in kind', 'Pending our action', 'Investment & Legal', 'Immediate', '• Follow up with Seqoon for the documentation requested on 23 August: bank statements, in-kind evidence, valuation justification.
• Prepare a commercial settlement proposal opening at 2x with a 1x floor, framed as a settlement and not a contractual entitlement.
• Hold the conversion decision until the validity of the QEF is established.', 'Reem', '15 Sep 2026', 'NO', null, null, 'None currently', 'No support work while the conversion dispute is open.', '2026-08-30', null),
('co9', 9, 'Settle', 'CN', 'Watchlist', 'USD', 125000.0, 10000000.0, 0.2, '2024-02-28', '2026-02-28', '2028-02-29', 'Maturity', 'QEF USD 4.0m; Target Financing USD 5.0m; 24m from payment', 'On track', 'Investment Issue', 'Near-Term', '• Obtain an update on client onboarding and the expected go-live date.', 'Rafik', '30 Sep 2026', 'NO', null, null, 'Banking services', 'Match with Flend and support in SWIFT process.', '2026-08-30', null),
('co10', 10, 'Subsbase', 'CN', 'Wind down', 'USD', 125000.0, 10000000.0, 0.2, '2023-06-22', null, null, 'Acquihire / Dissolution / Liquidation', 'QEF USD 10.0m; Target Financing USD 15.0m; note counterparty is SubsBase Inc (BVI)', 'Pending company', 'Investment & Legal', 'Immediate', '• Await the founders'' response to the 30 August request; escalate if nothing is received.
• Confirm whether the liquidation extends to SubsBase Inc. (BVI), the Company under our note.
• On receipt, establish IP ownership and test it against the Clause 4(f) representation.
• Negotiate a settlement before formal steps; then decide between recovery and write-off.', 'Rafik', '15 Sep 2026', 'NO', null, null, 'None currently', 'No support work; company in liquidation.', '2026-08-30', null),
('co11', 11, 'Unlock', 'CN', 'Wind down', 'USD', 125000.0, 3000000.0, 0.2, '2024-02-28', '2026-02-28', null, 'Maturity', 'QEF USD 300k; Target Financing USD 600k; 24m from payment', 'Pending company', 'Investment Issue', 'Near-Term', '• Put the recommendation to place the company in the wind-down bucket and stop routine communication and updates.', 'Rafik', '30 Sep 2026', 'NO', null, null, 'None currently', 'No support work; wind down recommended.', '2026-08-30', null),
('co12', 12, 'Zammit', 'CN', 'Wind down', 'USD', 125000.0, 10000000.0, 0.2, '2023-06-14', '2025-06-14', null, 'Acquihire / Dissolution / Liquidation', 'Acquihire by Zid; QEF USD 4.0m; Target Financing USD 7.0m', 'Pending legal', 'Investment & Legal', 'Immediate', '• Follow up on the opco and holdco financials requested on 25 August.
• Draft the updated restructure agreement and share it with Zammit once Misr Capital feedback is received.
• Agree the final terms of the restructure agreement.', 'Reem', '15 Sep 2026', 'YES', 'Legal review on the agreement and whether there is any breach (as per the draft shared earlier by Mina).', '2 working days', 'None currently', 'No support work; acquihire and restructure in progress.', '2026-08-30', '2026-08-30T09:00:00.000Z')
on conflict (id) do nothing;

-- ---------- 7. seed: the 58 history entries ----------
create unique index if not exists history_dedupe
  on public.history (entry_date, coalesce(company,''), md5(entry));
insert into public.history (entry_date, company, entry, source) values
('2022-06-13', 'Amanleek', 'Convertible Note signed. Note amount USD 125,000. Cap USD 3.0m, 20% discount, QEF USD 2.0m, Target Financing USD 10.0m. Counterparty Amanleek PTE. LTD. (Singapore).', 'Signed note'),
('2023-06-13', 'Agel', 'Convertible Note signed. USD 125,000. Cap USD 4.8m, QEF USD 1.0m, Target Financing USD 1.0m. Counterparty Agel Fintech Holding PTE. LTD.', 'Signed note'),
('2023-06-13', 'Bringy', 'Convertible Note signed. USD 125,000. Cap USD 6.0m, QEF USD 2.0m, Target Financing USD 10.0m. Counterparty Bringy, Inc (Delaware).', 'Signed note'),
('2023-06-13', 'Seqoon', 'Convertible Note signed. USD 125,000. Cap USD 6.0m, QEF USD 1.0m, Target Financing USD 3.0m. Counterparty Seqoon Inc (Delaware).', 'Signed note'),
('2023-06-13', 'Subsbase', 'Convertible Note signed. USD 125,000. Cap USD 10.0m, QEF USD 10.0m, Target Financing USD 15.0m. Counterparty SubsBase Inc (BVI).', 'Signed note'),
('2023-06-13', 'Zammit', 'Convertible Note signed. USD 125,000. Cap USD 10.0m, QEF USD 4.0m, Target Financing USD 7.0m. Counterparty Zammit Inc (Delaware).', 'Signed note'),
('2023-06-14', 'Agel', 'Note amount paid. Maturity therefore 14 June 2025.', 'BMV Overview'),
('2023-06-14', 'Amanleek', 'Note amount paid. Maturity therefore 14 June 2025.', 'BMV Overview'),
('2023-06-14', 'Bringy', 'Note amount paid. Maturity therefore 14 June 2025.', 'BMV Overview'),
('2023-06-14', 'Seqoon', 'Note amount paid. Maturity therefore 14 June 2025.', 'BMV Overview'),
('2023-06-14', 'Zammit', 'Note amount paid. Maturity therefore 14 June 2025.', 'BMV Overview'),
('2023-06-22', 'Subsbase', 'Note amount paid. Maturity therefore 22 June 2025.', 'BMV Overview'),
('2023-12-24', 'Flend', 'Convertible Note signed. USD 125,000. Cap USD 6.0m, QEF USD 2.0m, Target Financing USD 3.0m. Counterparty Flend PTE. LTD. (Singapore).', 'Signed note'),
('2023-12-24', 'Settle', 'Convertible Note signed. USD 125,000. Cap USD 10.0m, QEF USD 4.0m, Target Financing USD 5.0m. Counterparty STTL PTE. LTD. (Singapore).', 'Signed note'),
('2023-12-24', 'Unlock', 'Convertible Note signed. USD 125,000. Cap USD 3.0m, QEF USD 300k, Target Financing USD 600k. Counterparty Unlock International LTD (UK).', 'Signed note'),
('2024-02-11', 'Belmazad', 'Convertible Loan Note signed. EGP 14.0m principal. Pre-money cap EGP 114.0m, 30% discount, Equity Financing threshold EGP 19.0m. Maturity 24 months after first drawdown.', 'Signed CLN'),
('2024-02-28', 'Flash', 'Note amount paid (Tahweela, second round). Maturity therefore 28 February 2026.', 'BMV Overview'),
('2024-02-28', 'Flend', 'Note amount paid. Maturity therefore 28 February 2026.', 'BMV Overview'),
('2024-02-28', 'Settle', 'Note amount paid. Maturity therefore 28 February 2026.', 'BMV Overview'),
('2024-02-28', 'Unlock', 'Note amount paid. Maturity therefore 28 February 2026.', 'BMV Overview'),
('2024-07-31', 'Connect Money', 'SAFE signed. Purchase amount USD 1.0m (USD 750k in USD, USD 250k equivalent in EGP). Cap USD 15.0m, 50% discount, maturity 24 months. Side letter grants pre-emptive rights, key man, minority rights, preferred business partner, carve out and share swap option.', 'Signed SAFE + side letter'),
('2024-10-01', 'Flash', 'Deed of Adherence to the Tahweela Holdings shareholders agreement, signed by Misr Lel Ibtikar W Alreyada Bela Hodod.', 'Deed of Adherence'),
('2025-06-14', 'Agel', 'Note reached maturity. Subsequently extended.', 'BMV Overview'),
('2025-06-14', 'Amanleek', 'Note reached maturity. NOT extended, unlike every other note in the portfolio.', 'BMV Overview'),
('2025-06-14', 'Bringy', 'Note reached maturity. Subsequently extended.', 'BMV Overview'),
('2025-06-14', 'Seqoon', 'Note reached maturity. Subsequently extended.', 'BMV Overview'),
('2025-06-14', 'Zammit', 'Note reached maturity. Subsequently extended.', 'BMV Overview'),
('2025-06-22', 'Subsbase', 'Note reached maturity. Subsequently extended.', 'BMV Overview'),
('2026-02-28', 'Flash', 'Note reached maturity. Subsequently extended.', 'BMV Overview'),
('2026-02-28', 'Flend', 'Note reached maturity. Subsequently extended.', 'BMV Overview'),
('2026-02-28', 'Settle', 'Note reached maturity. Subsequently extended.', 'BMV Overview'),
('2026-02-28', 'Unlock', 'Note reached maturity. Subsequently extended.', 'BMV Overview'),
('2026-06-03', 'Zammit', 'Signed conversion agreements received from the company.', 'Email'),
('2026-07-15', 'Zammit', 'Budget and May/June performance reports received after repeated chasing.', 'Email'),
('2026-07-31', 'Connect Money', 'SAFE reached its 24-month maturity date.', 'Signed SAFE'),
('2026-08-07', 'Connect Money', 'Connect B.V. announced the SAFE-2 / Pre-Series A round: primary up to USD 1.0m and secondary buyouts up to USD 2.0m, confirmations requested by 20 August.', 'Misr Capital memo'),
('2026-08-09', 'Connect Money', 'Misr Capital reviewed the proposal and sent questions on the valuation cap basis, use of funds, the plan, and expected ownership if BMV does not participate.', 'Misr Capital memo'),
('2026-08-12', 'Seqoon', 'Counsel reserved its position on the validity of the claimed Qualified Equity Financing pending the cap table, bank evidence of the USD 750k, and support for the USD 250k in-kind component.', 'Counsel email'),
('2026-08-17', 'Connect Money', 'Meeting with Connect management on SAFE-2 terms, valuation basis, new contracts, use of funds, Saudi expansion and expected dilution.', 'Meeting minutes'),
('2026-08-19', 'Bringy', 'Q2 update shared. Revenue EGP 900k, net loss EGP 1.5m; margins improving but still burning.', 'Company update'),
('2026-08-20', 'Connect Money', 'Round resized to primary ~USD 1.115m and secondary ~USD 2.555m, ~USD 3.7m total, final documents targeted 31 August. Misr Capital recommends against participating.', 'Misr Capital memo'),
('2026-08-23', 'Amanleek', 'Follow-up email sent on the preferred share issuance timeline.', 'Email'),
('2026-08-23', 'Seqoon', 'Reem requested the evidence and documentation needed to test whether the claimed QEF is valid.', 'Email'),
('2026-08-24', 'Zammit', 'Misr Capital advised that updated financials are required to support the restructure decision and noted the company has not shared them.', 'Misr Capital'),
('2026-08-25', 'Agel', 'Call with Reem. Company reported a signed deal with Alkan, upcoming attendance at LEAP, and a business plan being finalised.', 'Call'),
('2026-08-25', 'Belmazad', 'Misr Capital shared a valuation report by Karvy valuing Belmazad at EGP 270m, and recommends extending the note: BMV converts at the cap either way and accrues interest during the extension.', 'Misr Capital / Karvy'),
('2026-08-25', 'Flend', 'Misr Capital recommended a three-month extension so the note runs until the round closes. Reem queried why not six months.', 'Email'),
('2026-08-25', 'Zammit', 'Reem emailed the company requesting latest audited and unaudited financials for the opco and the holdco.', 'Email'),
('2026-08-26', 'Seqoon', 'Counsel recommended negotiating a commercial exit opening at 2x the original investment with a 1x floor, rather than enforcing the note.', 'Counsel opinion'),
('2026-08-26', 'Settle', 'Extension notice sent; signed and returned by the company the same day.', 'Extension notice'),
('2026-08-26', 'Subsbase', 'Counsel opinion received. Key question is whether the software and IP sit in the BVI company or the Egyptian opco; write-off identified as a possible outcome.', 'Counsel opinion'),
('2026-08-26', 'Unlock', 'Extension notice reviewed by counsel and sent to the company.', 'Extension notice'),
('2026-08-27', 'Belmazad', 'Mina emailed Shawarby requesting legal advice on the founders'' extension request. Turnaround expected within 2 working days.', 'Email'),
('2026-08-27', 'Connect Money', 'Company circulated the August 2026 cap table and financing scenario. It converts all SAFE T1 holders at USD 23m, giving Bank Misr 921,645 shares (4.35% of 21,197,845 fully diluted). BMV contractual USD 15m valuation cap is not applied in the model.', 'Connect cap table'),
('2026-08-30', 'Amanleek', 'Further follow-up sent pushing for an issuance timeline. No response received.', 'Email'),
('2026-08-30', 'Connect Money', 'BMV position set: do not join SAFE-2, move ahead with receiving a term sheet and signing the SHA.', 'BMV decision'),
('2026-08-30', 'Connect Money', 'Analysis of the SAFE against the cap table: the USD 15m cap read post-money gives 6.67%, an Equity Financing conversion at the 50% discount gives 6.06%, the company model gives 4.35%, and the strict pre-money reading of Company Capitalization gives 3.70%. Maturity conversion under Section 1(e) carries no discount and is the weakest route.', 'BMV analysis'),
('2026-08-30', 'Subsbase', 'Information request sent to the founders covering scope of the liquidation, IP registration and ownership, treatment of assets and liabilities, and their proposed approach to BM''s position. Rights expressly reserved and Sections 3(c) and 3(d) cited.', 'Email')
on conflict do nothing;

-- ---------- 8. seed: legend lists, fx rate, deck figures, standing note ----------
insert into public.settings (key, value) values
('lists', '{"priority": ["Immediate", "Near-Term", "Postponed", "No Action"], "issueType": ["Legal Issue", "Investment Issue", "Investment & Legal", "No Issue"], "bucket": ["Growing", "Stable", "Watchlist", "Pivoting", "Wind down"], "trigger": ["Maturity", "Financing round", "Sale or IPO", "Acquihire / Dissolution / Liquidation"], "track": ["Venture clienting", "Banking services", "Capacity building & acceleration", "Business model & market study", "None currently"], "yesNo": ["YES", "NO"], "status": ["On track", "Pending our action", "Pending legal", "Pending company"]}'::jsonb),
('fx', '50'::jsonb),
('asOf', '"30 August 2026"'::jsonb),
('dashNote', '"Connect: the SAFE matured 31 Jul 2026, has no extension mechanism, and the company cap table ignores our USD 15m cap. Amanleek is the only note past maturity that has not been extended; it matured 14 June 2025. EGP converted at the rate on the Legend tab. The BMV Overview lists a 13th company, Haktiv, which does not appear in this tracker."'::jsonb),
('sources', '"Sources: 14 signed agreements (CN / CLN / SAFE / SHA Deed of Adherence and the Connect side letter); BMV Overview of Investments (Contracts Summary) for payment dates and note amounts; correspondence to 30 August 2026."'::jsonb),
('reading', '[{"label": "Payment & Maturity", "text": "Taken from the BMV Overview of Investments. CN maturity is 24 months from PAYMENT, not signature. Round 1 paid 14 Jun 2023 (SubsBase 22 Jun 2023), Round 2 paid 28 Feb 2024."}, {"label": "Maturity & Status", "text": "Maturity shows the date that actually governs: the extension date where one was countersigned, otherwise the original. Past maturity is computed from that date, never typed, so a lapsed note cannot look covered. An extension notice that was sent but never signed does not extend anything (CLN cl. 14.1), so those notes still read as past maturity."}, {"label": "Discount", "text": "The economic discount. The CN template states a Discount Rate of 80%, which is a 20% discount, because the conversion price is multiplied by the rate."}, {"label": "Invested", "text": "Note Amount in the currency of the instrument. All BM Accelerator notes are USD 125,000 (cash plus in-kind plus accelerator programme). No FX is applied in the table; the dashboard converts EGP at the rate above."}, {"label": "Value Creation Plan", "text": "Entries marked ''Proposed'' are drafts for the team to confirm, not agreed plans."}, {"label": "Owner", "text": "Inferred from who acted in the correspondence. Confirm before circulating."}, {"label": "Legal columns", "text": "Reem''s fields. ''Legal Next Step?'' flags whether counsel input is the blocking item; ''Target Feedback'' is the turnaround expected from Shawarby."}, {"label": "NOT IN THIS TRACKER", "text": "The BMV Overview lists a 13th company, Haktiv (USD 125,000 note, USD 1.5m cap, QEF USD 300k, paid 14 Jun 2023). It does not appear here. Confirm whether it should be added."}]'::jsonb),
('triggerMap', '[{"instrument": "CN (BM Accelerator Convertible Note)", "triggers": "Qualified Equity Financing · Target Financing · Optional Conversion Event · Liquidity Event · Dissolution Event · Maturity · Investor termination for false representation"}, {"instrument": "CLN (Belmazad)", "triggers": "Equity Financing · Maturity Event · Dissolution Event · Liquidity Event"}, {"instrument": "SAFE (Connect Money)", "triggers": "Equity Financing · Liquidity Event · Dissolution Event · Maturity · Side letter rights (pre-emptive, key man, minority, preferred business partner, carve out, share swap)"}, {"instrument": "SHA (Flash / Tahweela)", "triggers": "Information rights · Reserved matters · Tag along and drag along · Exit or IPO"}]'::jsonb),
('investments', '{"source": "BMV Deck, July 2026 — slide 5, Investments Overview", "accelerator": {"companies": 11, "waves": [{"label": "Wave 1", "usd": 875000, "rate": 30.83, "companies": 7, "paid": "14 Jun 2023"}, {"label": "Wave 2", "usd": 500000, "rate": 30.89, "companies": 4, "paid": "28 Feb 2024"}]}, "direct": [{"name": "Connect Money", "tranches": [{"usd": 250000, "rate": 40}, {"usd": 750000, "rate": 48.62}], "note": "Fully paid"}, {"name": "Belmazad", "egp": 14000000, "paidEgp": 10000000, "committedEgp": 4000000, "note": "Paid 10Mn · Committed 4Mn"}], "reconcile": "The deck counts 13 companies: 11 accelerator plus Connect and Belmazad. This tracker holds 12 of them; Haktiv is not on the tracker."}'::jsonb)
on conflict (key) do update set value = excluded.value;
