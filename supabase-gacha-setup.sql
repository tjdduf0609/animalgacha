-- 가챠 하루 횟수 제한용 테이블/함수 (Supabase > SQL Editor에서 한 번만 실행)
-- IP 원문은 저장하지 않고, 서버에서 해시한 값만 저장합니다.

create table if not exists public.gacha_usage (
  day     date    not null,
  ip_hash text    not null,
  used    integer not null default 0,
  primary key (day, ip_hash)
);

-- 정책을 하나도 만들지 않으면 anon/authenticated 키로는 접근할 수 없고,
-- 서버(service_role)만 읽고 쓸 수 있습니다.
alter table public.gacha_usage enable row level security;

-- 횟수 1회 사용을 원자적으로 처리합니다.
--  반환값: 사용 후 누적 횟수(1~limit), 한도를 넘으면 -1
create or replace function public.gacha_consume(p_day date, p_ip_hash text, p_limit integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used integer;
begin
  insert into public.gacha_usage as u (day, ip_hash, used)
  values (p_day, p_ip_hash, 1)
  on conflict (day, ip_hash)
  do update set used = u.used + 1
  where u.used < p_limit
  returning u.used into v_used;

  if v_used is null then
    return -1;
  end if;

  -- 하루의 첫 사용 때 오래된 기록(7일 이전)을 정리합니다.
  if v_used = 1 then
    delete from public.gacha_usage where day < p_day - 7;
  end if;

  return v_used;
end;
$$;

revoke all on function public.gacha_consume(date, text, integer) from public, anon, authenticated;
grant execute on function public.gacha_consume(date, text, integer) to service_role;
