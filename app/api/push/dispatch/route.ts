import webpush from 'web-push';
import {MAX_BODY_BYTES, authorized, dispatch, parseDispatch, refusalLog} from '../../../../lib/push/dispatch.ts';
import {validVapidPublicKey, vapidSubjectProblem} from '../../../../lib/push/endpoint.ts';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

// Called only by the database scheduler (pg_net, see supabase/admin/push-scheduler.sql)
// with the shared secret. Server-only environment: DUTY_PUSH_SECRET, VAPID_PRIVATE_KEY,
// VAPID_PUBLIC_KEY, VAPID_SUBJECT. Every refusal happens before anything is sent, so
// the database may retry it; after that the answer is always 200 with one outcome each.
export async function POST(request: Request) {
  const headers = {'Cache-Control': 'no-store'};
  const secret = process.env.DUTY_PUSH_SECRET, publicKey = process.env.VAPID_PUBLIC_KEY, privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!secret || secret.length < 32) return Response.json({error: 'Not configured'}, {status: 503, headers});
  if (!authorized(request.headers.get('authorization'), secret)) return Response.json({error: 'Unauthorized'}, {status: 401, headers});
  if (!validVapidPublicKey(publicKey) || !privateKey) return Response.json({error: 'Not configured'}, {status: 503, headers});
  // Apple refuses every send signed with a placeholder subject (403 BadJwtToken): refuse first, with the reason.
  const subjectProblem = vapidSubjectProblem(subject);
  if (subjectProblem || !subject) {console.warn(`duty push: ${subjectProblem}`); return Response.json({error: subjectProblem}, {status: 503, headers});}
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return Response.json({error: 'Too large'}, {status: 413, headers});
  let body: unknown;
  try {body = JSON.parse(text);} catch {return Response.json({error: 'Invalid request'}, {status: 400, headers});}
  const messages = parseDispatch(body);
  if (!messages) return Response.json({error: 'Invalid request'}, {status: 400, headers});
  const vapidDetails = {subject, publicKey, privateKey};
  const result = await dispatch(messages, (subscription, payload, options) =>
    webpush.sendNotification(subscription, payload, {...options, vapidDetails, timeout: 10_000}));
  // Refusals are visible in the server log (host, kind, status, the service's reason) and in the
  // answer pg_net keeps (net._http_response); never an endpoint path, key or secret.
  for (const line of refusalLog(messages, result.results)) console.warn(line);
  return Response.json(result, {headers});
}
