-- Aura IA · Avaliação de IA: prova lado a lado entre modelos (ex.: Claude × OpenAI) com conversas típicas.
-- Cada rodada guarda a resposta de cada modelo, tempo, tokens e custo; a equipe marca 👍/👎 no Console.

CREATE TABLE public.ai_eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  models jsonb NOT NULL,              -- [{ "provider": "anthropic", "model": "claude-haiku-5-5", "role": "copilot" }, ...]
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  total integer NOT NULL DEFAULT 0,
  completed integer NOT NULL DEFAULT 0,
  error text,
  created_by uuid,
  created_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE public.ai_eval_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.ai_eval_runs(id) ON DELETE CASCADE,
  scenario_id text NOT NULL,
  scenario_title text NOT NULL,
  category text NOT NULL,
  expectation text,
  provider text NOT NULL,
  model text NOT NULL,
  output text,
  outcome text NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok', 'error', 'refused')),
  error text,
  latency_ms integer,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(14, 6) NOT NULL DEFAULT 0,
  rating smallint CHECK (rating IN (-1, 1)),
  rated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, scenario_id, provider, model)
);
CREATE INDEX ai_eval_results_run_idx ON public.ai_eval_results (run_id);

ALTER TABLE public.ai_eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_eval_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_eval_runs, public.ai_eval_results FROM PUBLIC, anon, authenticated;

-- Avança o contador da rodada e fecha quando terminar.
CREATE FUNCTION public.aura_eval_progress(p_run_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.ai_eval_runs r SET
    completed = (SELECT count(*) FROM public.ai_eval_results WHERE run_id = r.id),
    status = CASE WHEN (SELECT count(*) FROM public.ai_eval_results WHERE run_id = r.id) >= r.total THEN 'done' ELSE r.status END,
    finished_at = CASE WHEN (SELECT count(*) FROM public.ai_eval_results WHERE run_id = r.id) >= r.total THEN now() ELSE r.finished_at END
  WHERE r.id = p_run_id
$$;

REVOKE EXECUTE ON FUNCTION public.aura_eval_progress(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aura_eval_progress(uuid) TO service_role;
