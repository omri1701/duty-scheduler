import type {DutyClient} from './rpc.ts';
import {READ_ONLY_MESSAGE, type Environment} from './environment.ts';

const environments = new WeakMap<DutyClient, Environment>();
export function registerEnvironment(client: DutyClient, environment: Environment) {environments.set(client, environment);}
export function isReadOnly(client: DutyClient) {return environments.get(client)?.readOnly === true;}
export function assertWritable(client: DutyClient) {if (isReadOnly(client)) throw Error(READ_ONLY_MESSAGE);}
export function signOutSafely(client: DutyClient) {return client.auth.signOut({scope:isReadOnly(client)?'local':'global'});}

// Deny unknown RPCs too, including RPCs invoked with GET. Table writes cannot
// escape the workspace controller through another SDK call.
export function guardedFetch(url: string, environment: Environment, fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init), destination = new URL(request.url);
    if (destination.origin !== new URL(url).origin) throw Error('Unexpected Supabase destination.');
    if (environment.readOnly) {
      const path = destination.pathname;
      const read = request.method === 'GET' || request.method === 'HEAD';
      if(path==='/auth/v1/logout'&&destination.searchParams.get('scope')!=='local')throw Error('Production inspection can sign out only its own session.');
      if (path.startsWith('/rest/v1/rpc/') ? path !== '/rest/v1/rpc/duty_load' : path.startsWith('/rest/v1/') && !read) throw Error(READ_ONLY_MESSAGE);
      if (!read && !['/rest/v1/rpc/duty_load', '/auth/v1/token', '/auth/v1/logout', '/auth/v1/verify'].includes(path)) throw Error(READ_ONLY_MESSAGE);
    }
    return fetcher(request);
  };
}
