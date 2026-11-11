#!/bin/bash
#
# Seeds CrowdSieve the way a CrowdSec LAPI relaying to CAPI would: alert batches on /v2/signals and
# bouncer usage-metrics on /v3/usage-metrics, all sent to the proxy port. Run by start.sh.
#
#   seed.sh <proxy URL>
#
# The timestamps are relative to now, so the dashboard's time ranges always show them.
#
set -euo pipefail

PROXY_URL="$1"

iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
NOW="$(date -u +%s)"

# The machine of the agents behind the LAPI (lapi_servers[].source_machine_ids): the bouncer metrics
# land under the LAPI's name. Only its payload is read, as from a real LAPI JWT.
b64url() { base64 -w0 | tr '+/' '-_' | tr -d '='; }
AUTH="Bearer $(printf '{"alg":"HS256","typ":"JWT"}' | b64url).$(printf '{"id":"qa-agent"}' | b64url).qa"

# alert <scenario> <ip> <country> <lat> <lon> <as name> <minutes ago> <events> <decision: ban|captcha|none> <simulated: true|false> <machine>
alert() {
  local scenario="$1" ip="$2" cn="$3" lat="$4" lon="$5" as_name="$6" ago="$7" events="$8" decision="$9" simulated="${10}" machine="${11}"
  local start=$((NOW - ago * 60)) stop=$((NOW - ago * 60 + 90))
  local decisions='[]'
  if [ "$decision" != none ]; then
    decisions="[{\"origin\":\"crowdsec\",\"type\":\"$decision\",\"scope\":\"Ip\",\"value\":\"$ip\",\"duration\":\"4h\",\"scenario\":\"$scenario\",\"simulated\":$simulated}]"
  fi
  cat <<JSON
{"machine_id":"$machine","scenario":"$scenario","scenario_hash":"qa-$(printf '%s' "$scenario" | md5sum | cut -c1-12)","scenario_version":"0.3",
 "message":"Ip $ip performed '$scenario' ($events events over 90s) at $(iso $stop)",
 "events_count":$events,"start_at":"$(iso $start)","stop_at":"$(iso $stop)","capacity":5,"leakspeed":"10s",
 "simulated":$simulated,"remediation":$([ "$decision" != none ] && echo true || echo false),
 "events":[{"timestamp":"$(iso $start)","meta":[{"key":"source_ip","value":"$ip"},{"key":"service","value":"http"}]}],
 "decisions":$decisions,
 "source":{"scope":"Ip","value":"$ip","ip":"$ip","cn":"$cn","latitude":$lat,"longitude":$lon,"as_name":"$as_name","as_number":"64500"},
 "labels":null}
JSON
}

batch() {
  local sep="" out="["
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    # shellcheck disable=SC2086
    out+="$sep$(eval alert $line)"
    sep=","
  done
  printf '%s]' "$out"
}

post() {
  local path="$1" body="$2" code
  code="$(curl -s -o /tmp/crowdsieve-qa-seed.out -w '%{http_code}' -X POST "$PROXY_URL$path" \
    -H 'Content-Type: application/json' -H "Authorization: $AUTH" --data-binary "$body")"
  if [[ "$code" != 2?? ]]; then
    echo "Seeding $path failed with HTTP $code: $(cat /tmp/crowdsieve-qa-seed.out)" >&2
    exit 1
  fi
}

# Forwarded (they would reach CAPI): public IPs, with a decision, not simulated
post /v2/signals "$(batch <<'ALERTS'
crowdsecurity/ssh-bf 198.51.100.23 CN 39.9 116.4 'Example Hosting CN' 15 12 ban false qa-agent
crowdsecurity/ssh-bf 198.51.100.24 CN 31.2 121.5 'Example Hosting CN' 42 8 ban false qa-agent
crowdsecurity/http-probing 203.0.113.7 RU 55.75 37.62 'Example Transit RU' 70 30 ban false qa-agent
crowdsecurity/http-crawl-non_statics 203.0.113.81 US 37.77 -122.42 'Example Cloud US' 130 55 captcha false qa-agent
crowdsecurity/http-bad-user-agent 192.0.2.150 BR -23.55 -46.63 'Example Telecom BR' 240 3 ban false qa-agent-2
crowdsecurity/http-sensitive-files 192.0.2.201 DE 52.52 13.40 'Example Cloud DE' 420 6 ban false qa-agent-2
crowdsecurity/postfix-spam 198.51.100.99 FR 48.86 2.35 'Example ISP FR' 900 20 ban false qa-agent
crowdsecurity/ssh-slow-bf 203.0.113.140 IN 19.08 72.88 'Example Hosting IN' 1500 10 ban false qa-agent
crowdsecurity/http-cve-2021-41773 192.0.2.66 NL 52.37 4.90 'Example Cloud NL' 2880 2 ban false qa-agent-2
crowdsecurity/ssh-bf 198.51.100.23 CN 39.9 116.4 'Example Hosting CN' 4320 9 ban false qa-agent
ALERTS
)"

# Filtered (kept local): no decision, simulated, internal IPs (config/filters.d)
post /v2/signals "$(batch <<'ALERTS'
crowdsecurity/http-probing 203.0.113.12 GB 51.51 -0.13 'Example ISP GB' 25 4 none false qa-agent
crowdsecurity/http-crawl-non_statics 192.0.2.33 ES 40.42 -3.70 'Example ISP ES' 300 7 none false qa-agent-2
crowdsecurity/ssh-bf 203.0.113.200 VN 21.03 105.85 'Example Telecom VN' 60 6 ban true qa-agent
crowdsecurity/ssh-bf 10.1.2.3 FR 48.86 2.35 'Internal' 35 14 ban false qa-agent
crowdsecurity/http-probing 192.168.10.44 FR 48.86 2.35 'Internal' 180 25 ban false qa-agent-2
crowdsecurity/smb-bf 172.16.5.9 FR 48.86 2.35 'Internal' 1200 5 ban false qa-agent
ALERTS
)"

# Bouncer metrics: a firewall and an nginx bouncer, the last 8 windows of 15 minutes
metrics_blocks() {
  local dropped_base="$1" processed_base="$2" sep="" out="[" i ts
  for i in 8 7 6 5 4 3 2 1; do
    ts=$((NOW - i * 900))
    out+="$sep{\"meta\":{\"utc_now_timestamp\":$ts,\"window_size_seconds\":900},\"items\":["
    out+="{\"name\":\"active_decisions\",\"value\":$((10 + i)),\"unit\":\"ip\",\"labels\":{\"origin\":\"crowdsec\",\"ip_type\":\"ipv4\"}},"
    out+="{\"name\":\"dropped\",\"value\":$((dropped_base * (9 - i))),\"unit\":\"request\",\"labels\":{\"origin\":\"crowdsec\",\"remediation\":\"ban\"}},"
    out+="{\"name\":\"processed\",\"value\":$((processed_base + 37 * i)),\"unit\":\"request\",\"labels\":{\"ip_type\":\"ipv4\"}}]}"
    sep=","
  done
  printf '%s]' "$out"
}
post /v3/usage-metrics "$(cat <<JSON
{"remediation_components":[
  {"name":"cs-firewall-bouncer","type":"crowdsec-firewall-bouncer","version":"v0.0.31","os":{"name":"debian","version":"12"},"metrics":$(metrics_blocks 12 900)},
  {"name":"nginx-bouncer","type":"crowdsec-nginx-bouncer","version":"v1.0.8","os":{"name":"ubuntu","version":"24.04"},"metrics":$(metrics_blocks 4 2500)}
],"log_processors":[]}
JSON
)"

echo "    16 alerts (10 passing the filters, 6 filtered) and 2 bouncers seeded"
