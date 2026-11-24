import { describe, expect, it, vi } from 'vitest';
import { ZernioClient } from '../../supabase/functions/_shared/zernio.ts';

describe('desconectar número na Zernio', () => {
  const client = (res: Response) => {
    const f = vi.fn().mockResolvedValue(res);
    return { f, z: new ZernioClient('k', f as unknown as typeof fetch) };
  };
  it('usa DELETE na conta com a chave', async () => {
    const { f, z } = client(new Response('{"message":"ok"}', { status: 200 }));
    expect(await z.disconnectAccount('acc_1')).toBe('removed');
    expect(f.mock.calls[0][0]).toBe('https://zernio.com/api/v1/accounts/acc_1');
    expect(f.mock.calls[0][1]).toMatchObject({ method: 'DELETE', headers: { Authorization: 'Bearer k' } });
  });
  it('conta que já não existe serve', async () => {
    expect(await client(new Response('{}', { status: 404 })).z.disconnectAccount('acc_1')).toBe('not_found');
  });
  it('erro do provedor para tudo', async () => {
    await expect(client(new Response('x', { status: 500 })).z.disconnectAccount('acc_1')).rejects.toMatchObject({ code: 'provider_error' });
  });
  it('recusa id estranho sem chamar a Zernio', async () => {
    const { f, z } = client(new Response('{}'));
    await expect(z.disconnectAccount('../profiles')).rejects.toMatchObject({ code: 'invalid_account' });
    expect(f).not.toHaveBeenCalled();
  });
});
