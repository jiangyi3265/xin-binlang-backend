#!/usr/bin/env bash
set -Eeuo pipefail

archive="${1:?必须提供发布包路径}"
release_id="${2:?必须提供发布版本标识}"
root_dir="/opt/xin-binlang"
release_dir="${root_dir}/releases/${release_id}"
current_link="${root_dir}/current"
previous_release=""

if [[ ! -f "${archive}" ]]; then
  echo "发布包不存在：${archive}" >&2
  exit 1
fi

if [[ -L "${current_link}" ]]; then
  previous_release="$(readlink -f "${current_link}")"
fi

mkdir -p "${release_dir}"
tar -xzf "${archive}" -C "${release_dir}"
chown -R xin-binlang:xin-binlang "${release_dir}"
install -d -o xin-binlang -g xin-binlang -m 0750 "${root_dir}/shared/npm-cache"

cd "${release_dir}/backend"
sudo -u xin-binlang env \
  HOME="${root_dir}/shared" \
  PATH="${root_dir}/node/bin:/usr/bin:/bin" \
  npm_config_cache="${root_dir}/shared/npm-cache" \
  npm ci --omit=dev --no-audit --no-fund
chmod -R u=rwX,g=rX,o=rX "${release_dir}"

ln -sfn "${release_dir}" "${root_dir}/current.next"
mv -Tf "${root_dir}/current.next" "${current_link}"

if ! systemctl restart xin-binlang.service; then
  if [[ -n "${previous_release}" ]]; then ln -sfn "${previous_release}" "${current_link}"; fi
  systemctl restart xin-binlang.service || true
  exit 1
fi

for _ in {1..30}; do
  if curl -fsS --max-time 3 http://127.0.0.1:8897/api/health | grep -q '"database":"mysql"'; then
    rm -f "${archive}"
    echo "发布成功：${release_id}"
    exit 0
  fi
  sleep 1
done

echo "健康检查失败，执行回滚" >&2
if [[ -n "${previous_release}" ]]; then
  ln -sfn "${previous_release}" "${current_link}"
  systemctl restart xin-binlang.service
fi
exit 1
