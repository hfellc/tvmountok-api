// Home Assistant calendar sync. One event per lead, found again by a "[TVM#id]" marker in its description.
const env = process.env;
const HA_URL = (env.HA_URL || '').replace(/\/$/, '');
const HA_TOKEN = env.HA_TOKEN || '';
const CAL = env.HA_CALENDAR || 'calendar.tv_mount_ok';
const DEFAULT_MIN = Number(env.JOB_MINUTES || 90);
export const haEnabled = !!(HA_URL && HA_TOKEN);

const marker = (id) => `[TVM#${id}]`;

function wsCall(messages) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(HA_URL.replace(/^http/, 'ws') + '/api/websocket');
    const results = []; let i = 0;
    const timer = setTimeout(() => { ws.close(); reject(new Error('HA websocket timeout')); }, 15000);
    const done = (err) => { clearTimeout(timer); try { ws.close(); } catch {} err ? reject(err) : resolve(results); };
    const next = () => { if (i >= messages.length) return done(); ws.send(JSON.stringify({ id: i + 1, ...messages[i] })); };
    ws.onerror = () => done(new Error('HA websocket error'));
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN }));
      else if (d.type === 'auth_invalid') done(new Error('HA auth failed'));
      else if (d.type === 'auth_ok') next();
      else if (d.type === 'result') {
        if (!d.success) return done(new Error(`HA: ${d.error?.message || 'error'}`));
        results.push(d.result); i++; next();
      }
    };
  });
}

async function findEvents(id) {
  const start = new Date(Date.now() - 400 * 864e5).toISOString();
  const end = new Date(Date.now() + 800 * 864e5).toISOString();
  const r = await fetch(`${HA_URL}/api/calendars/${CAL}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, {
    headers: { Authorization: `Bearer ${HA_TOKEN}` }, signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`HA calendar list ${r.status}`);
  return (await r.json()).filter((e) => (e.description || '').includes(marker(id)));
}

// Make the calendar match the lead: confirmed + start time => one event; anything else => none (done leads keep theirs).
export async function syncCalendar(lead) {
  if (!haEnabled) return { ok: false, error: 'calendar not configured' };
  try {
    const existing = await findEvents(lead.id);
    const wanted = lead.status === 'confirmed' && lead.scheduled_start;
    if (!wanted && lead.status === 'done') return { ok: true, action: 'kept' };
    const msgs = existing.filter((e) => e.uid).map((e) => ({ type: 'calendar/event/delete', entity_id: CAL, uid: e.uid }));
    let action = msgs.length ? 'removed' : 'none';
    if (wanted) {
      const s = new Date(lead.scheduled_start);
      const e = lead.scheduled_end ? new Date(lead.scheduled_end) : new Date(s.getTime() + DEFAULT_MIN * 60000);
      const summary = `${lead.service || 'TV mounting'}: ${lead.name}`;
      const description = [`${lead.phone}${lead.email ? ' | ' + lead.email : ''}`, `${lead.town}${lead.size ? ' | ' + lead.size : ''}`,
        lead.price != null ? `Quoted $${lead.price}` : '', lead.message || '', marker(lead.id)].filter(Boolean).join('\n');
      msgs.push({ type: 'calendar/event/create', entity_id: CAL, event: { summary, dtstart: s.toISOString(), dtend: (e > s ? e : new Date(s.getTime() + DEFAULT_MIN * 60000)).toISOString(), description, location: lead.address || lead.town } });
      action = existing.length ? 'updated' : 'created';
    }
    if (msgs.length) await wsCall(msgs);
    return { ok: true, action };
  } catch (e) { console.error('calendar error', e.message); return { ok: false, error: e.message.slice(0, 120) }; }
}
