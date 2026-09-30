begin;

-- Configuration globale du récapitulatif hebdomadaire.
-- ISO : lundi=1 ... dimanche=7.
insert into public.configuration(cle, valeur)
values
  ('notifications_jour', '5'),
  ('notifications_heure', '08:00')
on conflict(cle) do nothing;


-- Lecture de la programmation.
create or replace function public.lire_configuration_notifications()
returns table(jour integer, heure text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.est_personnel() then
    raise exception 'Accès refusé.';
  end if;

  return query
  select
    coalesce(
      (select valeur::integer
       from public.configuration
       where cle='notifications_jour'),
      5
    ),
    coalesce(
      (select valeur
       from public.configuration
       where cle='notifications_heure'),
      '08:00'
    );
end
$$;

revoke all on function public.lire_configuration_notifications()
from public, anon;

grant execute on function public.lire_configuration_notifications()
to authenticated;


-- Modification de la programmation.
create or replace function public.modifier_configuration_notifications(
  p_jour integer,
  p_heure text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.est_admin() then
    raise exception 'Action réservée aux administrateurs.';
  end if;

  if p_jour < 1 or p_jour > 7 then
    raise exception 'Jour invalide.';
  end if;

  if p_heure !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Heure invalide.';
  end if;

  insert into public.configuration(cle, valeur)
  values ('notifications_jour', p_jour::text)
  on conflict(cle)
  do update set valeur=excluded.valeur;

  insert into public.configuration(cle, valeur)
  values ('notifications_heure', p_heure)
  on conflict(cle)
  do update set valeur=excluded.valeur;
end
$$;

revoke all on function public.modifier_configuration_notifications(integer,text)
from public, anon;

grant execute on function public.modifier_configuration_notifications(integer,text)
to authenticated;

commit;
