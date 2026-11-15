window.__ModuleLoader__.load({
  id: 'dsh-remote-worker',
  factory(require) {
    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

    var API = '/dsh-remote-worker/api2';
    var STYLE_ID = 'dsh-remote-worker-style';

    function installStyles() {
      if (document.getElementById(STYLE_ID)) return undefined;
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = [
        '.rw-page{display:flex;flex-direction:column;gap:12px;padding:2px 0 20px;font-size:13px}',
        '.rw-card{border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-l1,#fff)}',
        '.rw-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}',
        '.rw-head h3{font-size:14px;margin:0}',
        '.rw-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid var(--dsw-alias-border-l2,#eef1f4)}',
        '.rw-row:first-of-type{border-top:0}',
        '.rw-label{color:var(--dsw-alias-text-l2,#57606a);white-space:nowrap}',
        '.rw-value{color:var(--dsw-alias-text-l1,#1f2328);text-align:right;word-break:break-all}',
        '.rw-input,.rw-select,.rw-area{box-sizing:border-box;width:100%;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:7px;background:var(--dsw-alias-bg-l1,#fff);color:var(--dsw-alias-text-l1,#1f2328);font:inherit}',
        '.rw-area{min-height:64px;resize:vertical}',
        '.rw-field{display:flex;flex-direction:column;gap:5px;padding:7px 0;border-top:1px solid var(--dsw-alias-border-l2,#eef1f4)}',
        '.rw-field:first-of-type{border-top:0}',
        '.rw-hint{font-size:11px;color:var(--dsw-alias-text-l3,#8c959f)}',
        '.rw-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
        '.rw-btn{padding:7px 12px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:7px;background:var(--dsw-alias-bg-l1,#fff);color:var(--dsw-alias-text-l1,#1f2328);font:inherit;cursor:pointer}',
        '.rw-btn.primary{background:#4D6BFE;border-color:#4D6BFE;color:#fff}',
        '.rw-btn:disabled{opacity:.5;cursor:default}',
        '.rw-err{color:#d1242f}',
        '.rw-muted{color:var(--dsw-alias-text-l3,#8c959f)}',
        '.rw-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
        '.rw-check{display:flex;align-items:center;gap:8px;padding:7px 0;color:var(--dsw-alias-text-l1,#1f2328)}',
        '@media(max-width:640px){.rw-grid{grid-template-columns:1fr}.rw-row{align-items:flex-start;flex-direction:column;gap:4px}.rw-value{text-align:left}}',
      ].join('');
      document.head.appendChild(style);
      return function () { style.remove(); };
    }

    function api(path, options) {
      return fetch(API + path, {
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        ...(options || {}),
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok || body.ok === false) {
            var message = body.error || (body.error && body.error.message) || '请求失败'
            throw new Error(message + '（HTTP ' + response.status + '）')
          }
          return body
        })
      }, function (error) {
        throw new Error('网络不可达（' + (error && error.message ? error.message : 'fetch failed') + '）')
      })
    }

    function Row(props) {
      return h('div', { className: 'rw-row' },
        h('span', { className: 'rw-label' }, props.label),
        h('span', { className: 'rw-value' }, props.children));
    }

    function Field(props) {
      return h('div', { className: 'rw-field' },
        h('span', { className: 'rw-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'rw-hint' }, props.hint) : null);
    }

    function qqStateText(state) {
      var labels = {
        disabled: '已停用',
        unconfigured: '未配置',
        connecting: '连接中',
        hello: '握手中',
        identifying: '鉴权中',
        resuming: '恢复中',
        ready: '在线',
        reconnecting: '重连中',
        error: '错误',
        stopped: '已停止',
        'client-only': '仅客户端',
      };
      return labels[state] || '未知';
    }

    function SettingsPage() {
      var [status, setStatus] = useState(null);
      var [form, setForm] = useState(null);
      var [error, setError] = useState('');
      var [note, setNote] = useState('');
      var [busy, setBusy] = useState(false);
      var [workspaces, setWorkspaces] = useState([]);

      function loadWorkspaces() {
        return api('/workspaces').then(function (result) {
          setWorkspaces(Array.isArray(result.workspaces) ? result.workspaces : []);
        }).catch(function () {
          setWorkspaces([]);
        });
      }

      function load() {
        setError('');
        loadWorkspaces();
        Promise.all([api('/status'), api('/config')]).then(function (values) {
          var nextStatus = values[0];
          var nextConfig = values[1].config || {};
          setStatus(nextStatus);
          setForm({
            role: nextConfig.role || 'auto',
            port: nextConfig.port || 3099,
            token: nextConfig.token || '',
            peerHost: nextConfig.peerHost || '',
            peerPort: nextConfig.peerPort || 3099,
            allowCommands: (nextConfig.allowCommands || []).join('\n'),
            allowCwd: (nextConfig.allowCwd || []).join('\n'),
            onOffline: nextConfig.onOffline || '',
            qq: {
              enabled: nextConfig.qq && nextConfig.qq.enabled === true,
              appId: nextConfig.qq && nextConfig.qq.appId ? nextConfig.qq.appId : '',
              appSecret: nextConfig.qq && nextConfig.qq.appSecret ? nextConfig.qq.appSecret : '',
              mode: nextConfig.qq && nextConfig.qq.mode === 'exec' ? 'exec' : 'natural',
              prefix: nextConfig.qq && nextConfig.qq.prefix ? nextConfig.qq.prefix : '/exec',
              whitelist: nextConfig.qq && Array.isArray(nextConfig.qq.whitelist)
                ? nextConfig.qq.whitelist.join('\n')
                : '',
              sessionId: nextConfig.qq && nextConfig.qq.sessionId ? nextConfig.qq.sessionId : '',
              cwd: nextConfig.qq && nextConfig.qq.cwd ? nextConfig.qq.cwd : '',
              retentionKeep: nextConfig.qq && nextConfig.qq.retentionKeep ? nextConfig.qq.retentionKeep : 200,
            },
          });
        }).catch(function (reason) {
          setError(reason && reason.message ? reason.message : '服务未启用');
        });
      }

      useEffect(function () {
        load();
      }, []);

      function patch(key, value) {
        setForm(function (current) { return { ...current, [key]: value }; });
        setNote('');
      }

      function patchQq(key, value) {
        setForm(function (current) {
          return { ...current, qq: { ...current.qq, [key]: value } };
        });
        setNote('');
      }

      function pickWorkspace(path) {
        choose({ cwd: path, sessionId: '' });
      }

      function chooseSession(id) {
        choose({ sessionId: id });
      }

      function choose(patch) {
        var next = { ...form, qq: { ...form.qq, ...patch } };
        setForm(next);
        submit(next, true);
      }

      function payloadOf(source) {
        return {
          role: source.role,
          port: Number(source.port),
          token: source.token,
          peerHost: source.peerHost,
          peerPort: Number(source.peerPort),
          allowCommands: source.allowCommands.split('\n').map(function (line) { return line.trim(); }).filter(Boolean),
          allowCwd: source.allowCwd.split('\n').map(function (line) { return line.trim(); }).filter(Boolean),
          onOffline: source.onOffline,
          qq: {
            enabled: source.qq.enabled,
            appId: source.qq.appId,
            appSecret: source.qq.appSecret,
            mode: source.qq.mode,
            prefix: source.qq.prefix,
            whitelist: source.qq.whitelist.split('\n').map(function (line) { return line.trim(); }).filter(Boolean),
            sessionId: source.qq.sessionId,
            cwd: source.qq.cwd,
            retentionKeep: Number(source.qq.retentionKeep) || 200,
          },
        };
      }

      function save() {
        submit(form, false);
      }

      function submit(source, quiet) {
        if (!quiet) {
          setBusy(true);
          setError('');
          setNote('');
        }
        api('/config', {
          method: 'POST',
          body: JSON.stringify(payloadOf(source)),
        }).then(function (result) {
          setNote(result.restartRequired ? '重启生效' : (quiet ? '已保存' : '已保存'));
          setError('');
          if (!quiet) load();
        }).catch(function (reason) {
          setError(reason && reason.message ? reason.message : '保存失败');
        }).finally(function () {
          setBusy(false);
        });
      }

      function rotate() {
        setBusy(true);
        setError('');
        api('/token', { method: 'POST', body: '{}' }).then(function (result) {
          patch('token', result.token);
          setNote('token 已更新');
        }).catch(function (reason) {
          setError(reason && reason.message ? reason.message : '生成失败');
        }).finally(function () {
          setBusy(false);
        });
      }

      if (!form) {
        return h('div', { className: 'rw-page' },
          h('div', { className: 'rw-card' },
            h('div', { className: 'rw-head' }, h('h3', null, '远程执行')),
            error ? h('div', { className: 'rw-err' }, error) : h('div', { className: 'rw-muted' }, '加载中')));
      }

      var caps = status && status.capabilities ? status.capabilities : {};
      var server = status && status.server ? status.server : {};
      var addresses = Array.isArray(server.addresses) ? server.addresses : [];
      var primary = addresses.find(function (item) { return item.global; }) || addresses[0];
      var canServe = caps.canServe === true;
      var qqAvailable = caps.serveEnabled === true;
      var qqStatus = status && status.qq ? status.qq : {};

      var [remoteQq, setRemoteQq] = React.useState(null);
      var [remoteErr, setRemoteErr] = React.useState('');

      function loadRemoteQq() {
        setRemoteErr('');
        api('/qq-remote').then(function (value) {
          setRemoteQq(value && value.ok ? value.snapshot : null);
          if (value && !value.ok) setRemoteErr(value.error || '读取失败');
        }, function (error) {
          setRemoteErr(error && error.message ? error.message : '读取失败');
        });
      }

      function pushRemote(patch) {
        setRemoteErr('');
        api('/qq-remote', {
          method: 'POST',
          body: JSON.stringify(patch),
        }).then(function (value) {
          if (value && value.ok) setRemoteQq(value.snapshot);
          else setRemoteErr((value && value.error) || '写入失败');
        }, function (error) {
          setRemoteErr(error && error.message ? error.message : '写入失败');
        });
      }

      var currentSessions = [];
      for (var index = 0; index < workspaces.length; index += 1) {
        if (workspaces[index] && workspaces[index].path === form.qq.cwd) {
          currentSessions = workspaces[index].sessions || [];
          break;
        }
      }

      return h('div', { className: 'rw-page' },
        h('div', { className: 'rw-card' },
          h('div', { className: 'rw-head' }, h('h3', null, '远程执行'),
            h('span', { className: 'rw-muted' }, canServe ? '电脑端' : '仅客户端')),
          h(Row, { label: '状态' }, server.error
            ? h('span', { className: 'rw-err' }, server.error.message || '监听失败')
            : (server.listening ? '监听中' : (canServe ? '未监听' : '仅客户端'))),
          h(Row, { label: '端口' }, String(server.port || form.port)),
          h(Row, { label: 'IPv6' }, primary ? primary.address : '无 IPv6'),
          h(Row, { label: '同步结果' }, status && status.reader && status.reader.enabled
            ? String(status.reader.unread || 0)
            : '未启用'),
          canServe ? h(Field, { label: '角色' },
            h('select', {
              className: 'rw-select',
              value: form.role,
              onChange: function (event) { patch('role', event.target.value); },
            },
              h('option', { value: 'auto' }, '自动'),
              h('option', { value: 'host' }, '电脑端'),
              h('option', { value: 'client' }, '手机端'))) : h(Row, { label: '角色' }, '仅客户端'),
          h('div', { className: 'rw-actions' },
            h('button', { className: 'rw-btn primary', type: 'button', disabled: busy, onClick: save }, busy ? '保存中' : '保存'),
            status && status.configRole !== form.role ? h('span', { className: 'rw-hint' }, '重启生效') : null,
            note ? h('span', { className: 'rw-hint' }, note) : null,
            error ? h('span', { className: 'rw-err' }, error) : null)),
        h('div', { className: 'rw-card' },
          h('h3', null, '连接'),
          h(Field, { label: '电脑 IPv6' },
            h('input', { className: 'rw-input', value: form.peerHost, placeholder: '2xxx:...',
              onChange: function (event) { patch('peerHost', event.target.value); } })),
          h(Field, { label: '电脑端口' },
            h('input', { className: 'rw-input', type: 'number', value: form.peerPort,
              onChange: function (event) { patch('peerPort', event.target.value); } })),
          h(Field, { label: 'token' },
            h('input', { className: 'rw-input', value: form.token, placeholder: '两端一致',
              onChange: function (event) { patch('token', event.target.value); } })),
          h(Field, { label: '离线钩子', hint: '原样带入错误' },
            h('input', { className: 'rw-input', value: form.onOffline, placeholder: 'offline_queue',
              onChange: function (event) { patch('onOffline', event.target.value); } })),
          canServe ? h('div', { className: 'rw-actions' },
            h('button', { className: 'rw-btn', type: 'button', disabled: busy, onClick: rotate }, '生成 token')) : null),
        qqAvailable ? h('div', { className: 'rw-card' },
          h('div', { className: 'rw-head' },
            h('h3', null, 'QQ 通道'),
            h('span', { className: 'rw-muted' }, qqStateText(qqStatus.state))),
          h('label', { className: 'rw-check' },
            h('input', {
              type: 'checkbox',
              checked: form.qq.enabled === true,
              onChange: function (event) { patchQq('enabled', event.target.checked); },
            }),
            '启用'),
          h(Row, { label: '状态' }, qqStatus.lastError
            ? h('span', { className: 'rw-err' }, String(qqStatus.lastError).slice(0, 15))
            : qqStateText(qqStatus.state)),
          h(Field, { label: 'AppID' },
            h('input', { className: 'rw-input', value: form.qq.appId, placeholder: 'AppID',
              onChange: function (event) { patchQq('appId', event.target.value); } })),
          h(Field, { label: 'AppSecret' },
            h('input', { className: 'rw-input', type: 'password', value: form.qq.appSecret, placeholder: 'AppSecret',
              onChange: function (event) { patchQq('appSecret', event.target.value); } })),
          h(Field, { label: '模式' },
            h('select', {
              className: 'rw-select',
              value: form.qq.mode,
              onChange: function (event) { patchQq('mode', event.target.value); },
            },
              h('option', { value: 'natural' }, '自然语言'),
              h('option', { value: 'exec' }, '指令前缀'))),
          h(Field, { label: '前缀' },
            h('input', { className: 'rw-input', value: form.qq.prefix, placeholder: '/exec',
              onChange: function (event) { patchQq('prefix', event.target.value); } })),
          h(Field, { label: '白名单', hint: 'openid，每行一个' },
            h('textarea', { className: 'rw-area', value: form.qq.whitelist,
              onChange: function (event) { patchQq('whitelist', event.target.value); } })),
          h(Field, { label: '工作区', hint: '选择 DSH 工作区' },
            h('select', {
              className: 'rw-select',
              value: form.qq.cwd,
              onChange: function (event) { pickWorkspace(event.target.value); },
            },
              h('option', { value: '' }, '自动（空闲会话）'),
              workspaces.map(function (item) {
                return h('option', { key: item.id, value: item.path },
                  (item.title || item.path) + ' — ' + item.path);
              }),
              form.qq.cwd && !workspaces.some(function (item) { return item.path === form.qq.cwd; })
                ? h('option', { value: form.qq.cwd }, form.qq.cwd)
                : null)),
          h(Field, { label: '对话', hint: '选定后注入该会话' },
            h('select', {
              className: 'rw-select',
              value: form.qq.sessionId,
              onChange: function (event) { chooseSession(event.target.value); },
            },
              h('option', { value: '' }, form.qq.cwd ? '新建专用会话' : '自动'),
              currentSessions.map(function (item) {
                return h('option', { key: item.id, value: item.id },
                  (item.title || item.id.slice(0, 18))
                    + (item.live ? ' · 在线' : '')
                    + (item.updatedAt ? ' · ' + item.updatedAt.slice(0, 10) : ''));
              }),
              form.qq.sessionId && !currentSessions.some(function (item) { return item.id === form.qq.sessionId; })
                ? h('option', { value: form.qq.sessionId }, form.qq.sessionId)
                : null)),
          h(Row, { label: '刷新' },
            h('button', { className: 'rw-btn', type: 'button', onClick: loadWorkspaces }, '重新扫描工作区/对话')),
          h(Field, { label: '工作区路径', hint: '手动覆盖' },
            h('input', { className: 'rw-input', value: form.qq.cwd, placeholder: 'D:\\PC\\dsh',
              onChange: function (event) { patchQq('cwd', event.target.value); } })),
          h(Field, { label: '会话 ID', hint: '手动覆盖，优先于工作区' },
            h('input', { className: 'rw-input', value: form.qq.sessionId, placeholder: 'session-…',
              onChange: function (event) { patchQq('sessionId', event.target.value); } })),
          h(Field, { label: '保留', hint: '结果条数' },
            h('input', { className: 'rw-input', type: 'number', min: '1', max: '10000',
              value: form.qq.retentionKeep,
              onChange: function (event) { patchQq('retentionKeep', event.target.value); } })),
          h(Row, { label: '最后结果' }, qqStatus.lastResultAt ? '已写入' : '无'),
          h(Row, { label: '队列' }, String(qqStatus.queue || 0))) : null,
        canServe ? h('div', { className: 'rw-card' },
          h('h3', null, '白名单'),
          h(Field, { label: '命令', hint: '每行一条，* 全放行' },
            h('textarea', { className: 'rw-area', value: form.allowCommands, placeholder: '*',
              onChange: function (event) { patch('allowCommands', event.target.value); } })),
          h(Field, { label: '目录', hint: '默认用户 home' },
            h('textarea', { className: 'rw-area', value: form.allowCwd,
              onChange: function (event) { patch('allowCwd', event.target.value); } }))) : null,
        !qqAvailable ? h('div', { className: 'rw-card' },
          h('h3', null, '电脑端 QQ 通道'),
          h(Row, { label: '电脑' }, form.peerHost ? form.peerHost : '未配置 peerHost'),
          h(Row, { label: '状态' }, remoteErr
            ? h('span', { className: 'rw-err' }, String(remoteErr).slice(0, 15))
            : (remoteQq ? String(remoteQq.state || '未知') : '未读取')),
          remoteQq ? h(Row, { label: '当前工作区' }, remoteQq.workspaceCwd || '自动') : null,
          remoteQq ? h(Row, { label: '当前对话' }, remoteQq.workspaceSessionId || '自动') : null,
          h(Row, { label: '刷新' },
            h('button', { className: 'rw-btn', type: 'button', onClick: loadRemoteQq }, '读取电脑端')),
          remoteQq ? remoteWorkspaceList() : null,
          remoteQq ? remoteSessionList() : null) : null);
    }

    function remoteWorkspaceList() {
      var items = (remoteQq.workspaces || []);
      var options = [h('option', { value: '' }, '自动')];
      for (var index = 0; index < items.length; index += 1) {
        options.push(h('option', { value: items[index].path },
          (items[index].title || items[index].path) + ' · ' + items[index].sessions.length));
      }
      return h(Field, { label: '工作区', hint: '写入电脑端' },
        h('select', {
          className: 'rw-select',
          value: remoteQq.workspaceCwd || '',
          onChange: function (event) { pushRemote({ cwd: event.target.value, sessionId: '' }); },
        }, options));
    }

    function remoteSessionList() {
      var target = '';
      var items = (remoteQq.workspaces || []);
      for (var index = 0; index < items.length; index += 1) {
        if (items[index].path === remoteQq.workspaceCwd) { target = items[index].sessions || []; break; }
      }
      var options = [h('option', { value: '' }, '新建专用会话')];
      for (var cursor = 0; cursor < target.length; cursor += 1) {
        var item = target[cursor];
        options.push(h('option', { value: item.id },
          (item.title || '(untitled)') + (item.live ? ' · 在线' : '')));
      }
      return h(Field, { label: '对话', hint: '写入电脑端' },
        h('select', {
          className: 'rw-select',
          value: remoteQq.workspaceSessionId || '',
          onChange: function (event) { pushRemote({ sessionId: event.target.value }); },
        }, options));
    }

    function apply(ctx) {
      ctx.effect(installStyles, 'dsh-remote-worker: styles');
      ctx.effect(function () {
        return ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-remote-worker',
            order: 38,
            label: function () { return '远程执行'; },
          }, SettingsPage);
        });
      }, 'dsh-remote-worker: settings');
    }

    var module = { exports: {} };
    module.exports.apply = apply;
    module.exports.inject = ['slots'];
    module.exports.SettingsPage = SettingsPage;
    return module.exports;
  },
});
