-- Study Desk optional sync schema v1. Run in a new Supabase project's SQL Editor.
-- No service-role key is required by the browser.
create table if not exists public.study_records (
 owner_id uuid not null references auth.users(id) on delete cascade,
 id text not null,
 revision bigint not null,
 data jsonb not null,
 primary key(owner_id,id),
 check (jsonb_typeof(data)='object' and data->>'id'=id)
);
alter table public.study_records enable row level security;
revoke all on public.study_records from anon, authenticated;
-- All authenticated writes/reads go through the ownership-checking RPCs below.
create policy study_owner_select on public.study_records for select to authenticated using(auth.uid()=owner_id);
create policy study_owner_insert on public.study_records for insert to authenticated with check(auth.uid()=owner_id);
create policy study_owner_update on public.study_records for update to authenticated using(auth.uid()=owner_id) with check(auth.uid()=owner_id);
create sequence if not exists public.study_revision_seq;
create or replace function public.study_push(p_id text,p_expected bigint,p_data jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); oldrow public.study_records%rowtype; newrev bigint;
begin
 if uid is null then raise exception 'Authentication required'; end if;
 if p_expected is null or p_expected<0 or p_id is null or length(p_id)=0 or length(p_id)>200 or p_data->>'id' is distinct from p_id or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>2000000 then raise exception 'Invalid record'; end if;
 if p_data->>'kind' is null or p_data->>'kind' not in ('target','subject','unit','session','task','note','card','attempt','question') or not (p_data ? 'version') or jsonb_typeof(p_data->'version')<>'number' then raise exception 'Invalid entity'; end if;
 -- Serialize every write and cursor read for this owner, avoiding sequence commit gaps.
 perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
 select * into oldrow from public.study_records where owner_id=uid and id=p_id;
 if (oldrow.id is null and p_expected<>0) or (oldrow.id is not null and oldrow.revision<>p_expected) then
  return jsonb_build_object('ok',false,'revision',coalesce(oldrow.revision,0),'data',oldrow.data);
 end if;
 newrev:=nextval('public.study_revision_seq');
 insert into public.study_records(owner_id,id,revision,data) values(uid,p_id,newrev,p_data)
 on conflict(owner_id,id) do update set revision=excluded.revision,data=excluded.data;
 return jsonb_build_object('ok',true,'revision',newrev,'data',p_data);
end $$;
create or replace function public.study_pull(p_cursor bigint default 0)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); result jsonb; top_revision bigint;
begin
 if uid is null then raise exception 'Authentication required'; end if;
 if p_cursor is null or p_cursor<0 then raise exception 'Invalid cursor'; end if;
 perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
 select coalesce(max(revision),0) into top_revision from public.study_records where owner_id=uid;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'revision',revision,'data',data) order by revision),'[]'::jsonb) into result from public.study_records where owner_id=uid and revision>p_cursor;
 return jsonb_build_object('cursor',top_revision,'records',result);
end $$;
revoke all on function public.study_push(text,bigint,jsonb) from public,anon;
revoke all on function public.study_pull(bigint) from public,anon;
grant execute on function public.study_push(text,bigint,jsonb) to authenticated;
grant execute on function public.study_pull(bigint) to authenticated;
