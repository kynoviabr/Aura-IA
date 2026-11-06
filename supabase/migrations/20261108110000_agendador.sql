-- Agendador da Aura IA: verificação a cada 15 min (chaves de IA, saúde dos números) e reentrega de avisos a cada minuto.
-- A senha do agendador fica no cofre (aura_cron_secret) e é lida na hora da chamada.
-- Atenção: o endereço do projeto está fixo; em produção, trocar pelo endereço do projeto de produção.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION private.call_aura_function(p_name text)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT net.http_post(
    url := 'https://kkkxyvchdtjagvmevxve.supabase.co/functions/v1/' || p_name,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-aura-cron', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'aura_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  )
$$;
REVOKE EXECUTE ON FUNCTION private.call_aura_function(text) FROM PUBLIC;

SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname IN ('aura-health-check', 'aura-dispatch-events');
SELECT cron.schedule('aura-health-check', '*/15 * * * *', $$SELECT private.call_aura_function('health-check')$$);
SELECT cron.schedule('aura-dispatch-events', '* * * * *', $$SELECT private.call_aura_function('dispatch-events')$$);
