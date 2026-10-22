window.__ModuleLoader__.load({
  id: '@pyh-pan/dsh-openai-oauth',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'local-chatgpt-source';
    const LOGO =
      'data:image/svg+xml;charset=utf-8,%3Csvg%20width%3D%2221%22%20height%3D%2221%22%20viewBox%3D%220%200%2021%2021%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%0A%3Cpath%20d%3D%22M11.8102%2019.1625C11.2327%2019.1625%2010.6841%2019.0528%2010.1643%2018.8334C9.64459%2018.6139%209.18259%2018.3078%208.77834%2017.9151C8.33944%2018.0653%207.88322%2018.1404%207.40967%2018.1404C6.63582%2018.1404%205.91972%2017.9498%205.26137%2017.5686C4.60302%2017.1875%204.07172%2016.6677%203.66747%2016.0094C3.27477%2015.351%203.07842%2014.6176%203.07842%2013.8091C3.07842%2013.4742%203.12462%2013.1103%203.21702%2012.7176C2.75502%2012.2903%202.39697%2011.7994%202.14287%2011.245C1.88877%2010.679%201.76172%2010.09%201.76172%209.47785C1.76172%208.85415%201.89454%208.25355%202.16019%207.67605C2.42584%207.09855%202.79544%206.6019%203.26899%206.1861C3.75409%205.75875%204.31427%205.46422%204.94952%205.30252C5.07657%204.64417%205.34222%204.05512%205.74647%203.53537C6.16227%203.00407%206.67047%202.58827%207.27107%202.28797C7.87167%201.98767%208.51269%201.83752%209.19414%201.83752C9.77164%201.83752%2010.3203%201.94725%2010.84%202.1667C11.3598%202.38615%2011.8218%202.69222%2012.226%203.08492C12.6649%202.93477%2013.1211%202.8597%2013.5947%202.8597C14.3685%202.8597%2015.0846%203.05027%2015.743%203.43142C16.4013%203.81257%2016.9269%204.33232%2017.3196%204.99067C17.7238%205.64902%2017.9259%206.38245%2017.9259%207.19095C17.9259%207.5259%2017.8797%207.88973%2017.7873%208.28242C18.2493%208.70977%2018.6074%209.20643%2018.8615%209.77238C19.1156%2010.3268%2019.2426%2010.91%2019.2426%2011.5222C19.2426%2012.1459%2019.1098%2012.7465%2018.8442%2013.324C18.5785%2013.9015%2018.2031%2014.4039%2017.718%2014.8313C17.2445%2015.2471%2016.6901%2015.5358%2016.0548%2015.6975C15.9278%2016.3559%2015.6564%2016.9449%2015.2406%2017.4647C14.8363%2017.996%2014.3339%2018.4118%2013.7333%2018.7121C13.1327%2019.0124%2012.4917%2019.1625%2011.8102%2019.1625ZM7.53094%2016.9969C8.10844%2016.9969%208.61087%2016.8756%209.03822%2016.6331L12.2953%2014.762C12.4108%2014.6811%2012.4686%2014.5714%2012.4686%2014.4328V12.9429L8.27592%2015.351C8.02182%2015.5012%207.76772%2015.5012%207.51362%2015.351L4.23919%2013.4626C4.23919%2013.4973%204.23342%2013.5377%204.22187%2013.5839C4.22187%2013.6301%204.22187%2013.6994%204.22187%2013.7918C4.22187%2014.3808%204.36047%2014.9237%204.63767%2015.4203C4.92642%2015.9054%205.32489%2016.2866%205.83309%2016.5638C6.34129%2016.8525%206.90724%2016.9969%207.53094%2016.9969ZM7.70419%2014.1729C7.77349%2014.2076%207.83702%2014.2249%207.89477%2014.2249C7.95252%2014.2249%208.01027%2014.2076%208.06802%2014.1729L9.36739%2013.4279L5.19207%2011.0024C4.93797%2010.8523%204.81092%2010.6271%204.81092%2010.3268V6.56725C4.23342%206.82135%203.77142%207.21405%203.42492%207.74535C3.07842%208.2651%202.90517%208.8426%202.90517%209.47785C2.90517%2010.0438%203.04954%2010.5866%203.33829%2011.1064C3.62704%2011.6261%204.00242%2012.0189%204.46442%2012.2845L7.70419%2014.1729ZM11.8102%2018.0191C12.4224%2018.0191%2012.9768%2017.8805%2013.4734%2017.6033C13.9701%2017.3261%2014.3628%2016.9449%2014.6515%2016.4598C14.9403%2015.9747%2015.0846%2015.4319%2015.0846%2014.8313V11.0891C15.0846%2010.9505%2015.0269%2010.8465%2014.9114%2010.7772L13.5947%2010.0149V14.8486C13.5947%2015.1489%2013.4676%2015.3741%2013.2135%2015.5243L9.93912%2017.4127C10.5051%2017.817%2011.1288%2018.0191%2011.8102%2018.0191ZM12.4686%2011.6781V9.32192L10.5108%208.21312L8.53579%209.32192V11.6781L10.5108%2012.7869L12.4686%2011.6781ZM7.40967%206.15145C7.40967%205.85115%207.53672%205.62592%207.79082%205.47577L11.0652%203.58735C10.4993%203.1831%209.87559%202.98097%209.19414%202.98097C8.58199%202.98097%208.02759%203.11957%207.53094%203.39677C7.03429%203.67397%206.64159%204.05512%206.35284%204.54022C6.07564%205.02532%205.93704%205.56817%205.93704%206.16878V9.89365C5.93704%2010.0323%205.99479%2010.142%206.11029%2010.2228L7.40967%2010.9851V6.15145ZM16.2108%2014.4328C16.7883%2014.1787%2017.2445%2013.786%2017.5794%2013.2547C17.9259%2012.7234%2018.0992%2012.1459%2018.0992%2011.5222C18.0992%2010.9562%2017.9548%2010.4134%2017.6661%209.89365C17.3773%209.3739%2017.0019%208.9812%2016.5399%208.71555L13.3002%206.84445C13.2309%206.79825%2013.1673%206.78092%2013.1096%206.79248C13.0518%206.79248%2012.9941%206.8098%2012.9363%206.84445L11.637%207.5721L15.8296%2010.0149C15.9567%2010.0842%2016.0491%2010.1766%2016.1068%2010.2921C16.1761%2010.3961%2016.2108%2010.5231%2016.2108%2010.6733V14.4328ZM12.7284%205.6317C12.9825%205.47%2013.2366%205.47%2013.4907%205.6317L16.7825%207.55477C16.7825%207.47393%2016.7825%207.36997%2016.7825%207.24292C16.7825%206.68852%2016.6439%206.163%2016.3667%205.66635C16.101%205.15815%2015.7141%204.7539%2015.2059%204.4536C14.7093%204.1533%2014.1318%204.00315%2013.4734%204.00315C12.8959%204.00315%2012.3935%204.12442%2011.9661%204.36697L8.70904%206.23808C8.59354%206.31892%208.53579%206.42865%208.53579%206.56725V8.0572L12.7284%205.6317Z%22%20fill%3D%22white%22%2F%3E%0A%3C%2Fsvg%3E';
    const USAGE = 'https://chatgpt.com/settings/usage';
    const zh = {
      title: 'ChatGPT 订阅',
      subtitle: '独立模型源 / 官方 SIWC',
      intro: '让符合条件的请求使用你的 ChatGPT 订阅额度。DeepSeek 与其他模型源保持不变。',
      loading: '正在读取授权状态…',
      empty: '尚未添加 ChatGPT 账号',
      emptyHint: '首次授权时，可在 OpenAI 页面为此应用命名 Agent。',
      addHint: '添加另一个账号或工作区',
      continue: 'Continue with ChatGPT',
      choose: '使用此账号',
      active: '当前账号',
      available: '已授权',
      disabled: '订阅推理未启用',
      pending: '注册待完成',
      signedOut: '已退出',
      reauth: '需重新授权',
      signAgain: '重新授权',
      enable: '启用订阅推理',
      logout: '退出',
      refresh: '刷新状态',
      manage: '管理用量',
      source: 'chatgpt-subscription',
      selectHint:
        '授权后，先在这里选择账号，再在原有模型选择器中选择 ChatGPT Subscription 下的模型。不会自动切换当前会话。',
      opening: '在 OpenAI 完成授权',
      verifying: '正在校验身份与授权…',
      browser: '打开 OpenAI 授权页面',
      secure: 'auth.openai.com · 仅在官方页面登录',
      waitingHint: '请在系统浏览器继续。此窗口会自动更新；回调监听仅限本机，并在取消或超时后关闭。',
      cancel: '取消授权',
      cancelled: '授权已取消，原账号与模型选择未变。',
      expired: '授权已超时，请重新开始。',
      authorized: '授权已保存。请选择此账号以启用模型目录。',
      signedOnly: '已验证登录身份，但尚未允许使用 ChatGPT 订阅。可选择“启用订阅推理”继续。',
      failed: '操作未完成',
      network: '暂时无法连接桌面 Host，请稍后刷新。',
      confirmTitle: '退出此账号？',
      confirmText:
        '会尝试撤销此注册实例的可续期会话，并清除此账号的本地 Token。不会撤销 Pi、DeepSeek 或其他账号的授权。',
      confirm: '确认退出',
      back: '返回',
      remoteUnknown: '本地已退出，但远端撤销尚未确认。请在 ChatGPT 设置中检查并断开本应用。',
      welcomeTitle: '你正在使用 ChatGPT 订阅',
      welcomeText:
        '本源下符合条件的 AI 请求会使用你所选账号的 ChatGPT 订阅额度或积分。你可以在 ChatGPT 设置中查看本应用的用量并调整限制。',
      welcomeHint: '选择此账号后，仍由你在原有模型选择器中决定是否使用此源。',
      gotIt: '知道了',
      usingPlan: '正在使用 ChatGPT 订阅',
      needsAccount: 'ChatGPT 订阅 · 待选择账号',
      quota: '本应用或订阅用量已达限制',
      limits:
        '不是 OpenAI API 余额通道。模型可用性与限额由账号及 OpenAI 决定；Token 仅留在桌面 Host。',
      preview:
        '当前官方预览不支持 maxTokens / temperature。若会话中手动设置了这些参数，使用此源前请清空；插件不会静默忽略它们。',
      AUTH_BUSY: '授权或退出正在进行，请等待或取消当前操作。',
      ACCESS_DENIED: '你取消或拒绝了授权，已有账号未受影响。',
      INVALID_GRANT: '授权码已失效。请选择列表中的待完成注册重新授权，不必重复创建 Agent。',
      ACCOUNT_MISMATCH: '授权返回的账号与所选注册不一致，原凭据没有被替换。',
      DIRECT_PERMISSION_MISSING: '此账号未授予订阅推理权限，请显式选择“启用订阅推理”。',
      ACCOUNT_REAUTH_REQUIRED: '请重新授权此账号，或选择另一个已授权账号。',
      AUTH_DNS_FAILED:
        '无法解析 auth.openai.com，有限重试后仍失败。请检查 DNS 和网络；已有授权已保留。',
      AUTH_CONNECT_FAILED:
        '无法连接 auth.openai.com，有限重试后仍失败。请检查网络或代理；已有授权已保留。',
      AUTH_TLS_FAILED:
        '无法验证 auth.openai.com 的 TLS 证书。请检查系统时间和网络证书；未绕过证书校验。',
      AUTH_NETWORK_FAILED:
        '暂时无法读取 OpenAI 授权信息，有限重试后仍失败。请检查网络；已有授权已保留。',
      AUTH_NETWORK_TIMEOUT:
        '连接 OpenAI 授权服务超时。请检查 auth.openai.com 的可达性；已有授权已保留。',
      AUTH_REQUEST_UNCONFIRMED:
        '授权请求的连接中断，无法确认远端是否已处理。为避免重复轮换凭据，未自动重发；请在模型设置中确认账号状态。',
      ATTACHMENT_SERVICE_UNAVAILABLE: '当前 DSH 无法提供已校验的附件字节，未发送附件。',
      ATTACHMENT_REFERENCE_INVALID: '附件引用无效，请重新添加原文件。',
      ATTACHMENT_READ_FAILED: '无法读取或校验已保存的附件，未发送推理请求。',
      ATTACHMENT_READ_TIMEOUT: '本地附件准备超时，未发送推理请求。',
      ATTACHMENT_CORRUPT: '附件内容与已保存的校验信息不一致，未发送推理请求。',
      ATTACHMENT_TOO_LARGE: '附件历史超过数量或大小限制，请减少附件或新建会话。',
      ATTACHMENT_FILE_TYPE_UNSUPPORTED:
        '暂不支持将此文件格式直接传给模型，请改用受支持的文档格式或本地文件工具。',
      ATTACHMENT_MODEL_UNSUPPORTED: '模型目录明确不支持此附件类型，请选择支持该输入的模型。',
      ATTACHMENT_PROJECTION_CHANGED:
        'DSH 原生附件投影契约发生变化，已停止发送，不会从聊天文本中猜测文件路径。',
      MODEL_CATALOG_CHANGED: '模型目录在准备请求时发生变化，请重新加载模型目录后重试。',
      VERSION_MISMATCH:
        '桌面 Host 尚未加载 SIWC 新版本。请重启 DSH 后再使用；没有启动旧 Codex 登录。',
    };
    const en = {
      title: 'ChatGPT subscription',
      subtitle: 'Independent source / official SIWC',
      intro:
        'Use your ChatGPT plan for eligible requests. DeepSeek and all existing model sources stay unchanged.',
      loading: 'Reading authorization status…',
      empty: 'No ChatGPT account yet',
      emptyHint: 'On first authorization, name this app’s Agent on the OpenAI page.',
      addHint: 'Add another account or workspace',
      continue: 'Continue with ChatGPT',
      choose: 'Use this account',
      active: 'Active account',
      available: 'Authorized',
      disabled: 'Plan use disabled',
      pending: 'Registration incomplete',
      signedOut: 'Signed out',
      reauth: 'Sign-in required',
      signAgain: 'Authorize again',
      enable: 'Enable ChatGPT plan use',
      logout: 'Sign out',
      refresh: 'Refresh status',
      manage: 'Manage usage',
      source: 'chatgpt-subscription',
      selectHint:
        'After authorization, choose an account here, then select a model under ChatGPT Subscription in the existing model picker. Your current session is not switched automatically.',
      opening: 'Continue authorization with OpenAI',
      verifying: 'Verifying identity and permissions…',
      browser: 'Open OpenAI authorization',
      secure: 'auth.openai.com · sign in only on the official page',
      waitingHint:
        'Continue in your system browser. This view updates automatically. The callback listener is local-only and closes on cancellation or expiry.',
      cancel: 'Cancel sign-in',
      cancelled: 'Sign-in cancelled. Existing account and model selections are unchanged.',
      expired: 'Sign-in expired. Please start again.',
      authorized: 'Authorization saved. Choose this account to enable its model catalog.',
      signedOnly:
        'Identity verified, but ChatGPT plan use was not granted. Choose “Enable ChatGPT plan use” to continue.',
      failed: 'The operation did not complete',
      network: 'Cannot reach the desktop Host. Please refresh shortly.',
      confirmTitle: 'Sign out of this account?',
      confirmText:
        'Attempts to revoke this registration’s renewable session and clears its local tokens. Pi, DeepSeek, and other saved accounts are not revoked.',
      confirm: 'Confirm sign-out',
      back: 'Back',
      remoteUnknown:
        'Signed out locally, but remote revocation was not confirmed. Review and disconnect this app in ChatGPT settings.',
      welcomeTitle: 'You’re using your ChatGPT plan',
      welcomeText:
        'Eligible requests through this source use the selected account’s ChatGPT plan or credits. Review this app’s usage and adjust limits in ChatGPT settings.',
      welcomeHint:
        'After choosing an account, you still decide whether to use this source in the existing model picker.',
      gotIt: 'Got it',
      usingPlan: 'Using ChatGPT plan',
      needsAccount: 'ChatGPT plan · choose an account',
      quota: 'Plan or app usage limit reached',
      limits:
        'Not an OpenAI API balance route. Models and limits depend on your account and OpenAI. Tokens stay on the desktop Host.',
      preview:
        'The current official preview does not support maxTokens / temperature. Clear manually configured values before using this source; they are never silently ignored.',
      AUTH_BUSY: 'Another authorization or sign-out is in progress. Wait or cancel it first.',
      ACCESS_DENIED: 'Authorization was declined or cancelled. Existing accounts were not changed.',
      INVALID_GRANT:
        'The authorization code expired. Continue the saved incomplete registration instead of creating another Agent.',
      ACCOUNT_MISMATCH:
        'The returned account does not match the selected registration. Its credentials were not replaced.',
      DIRECT_PERMISSION_MISSING:
        'ChatGPT plan use was not granted. Explicitly choose “Enable ChatGPT plan use”.',
      ACCOUNT_REAUTH_REQUIRED: 'Authorize this account again or choose another authorized account.',
      AUTH_DNS_FAILED:
        'Cannot resolve auth.openai.com after bounded retries. Check DNS and network access; existing authorization was kept.',
      AUTH_CONNECT_FAILED:
        'Cannot connect to auth.openai.com after bounded retries. Check network or proxy access; existing authorization was kept.',
      AUTH_TLS_FAILED:
        'Cannot verify TLS for auth.openai.com. Check the system clock and network certificates; verification was not bypassed.',
      AUTH_NETWORK_FAILED:
        'Cannot read OpenAI authorization metadata after bounded retries. Check network access; existing authorization was kept.',
      AUTH_NETWORK_TIMEOUT:
        'The OpenAI authorization network deadline expired. Check access to auth.openai.com; existing authorization was kept.',
      AUTH_REQUEST_UNCONFIRMED:
        'The authorization connection ended before confirmation. To avoid replaying a rotating credential, the request was not automatically resent; check the account status in model settings.',
      ATTACHMENT_SERVICE_UNAVAILABLE:
        'This DSH runtime cannot supply verified attachment bytes. No attachment was sent.',
      ATTACHMENT_REFERENCE_INVALID:
        'The attachment reference is invalid. Attach the original file again.',
      ATTACHMENT_READ_FAILED:
        'The saved attachment could not be read or verified. No inference request was sent.',
      ATTACHMENT_READ_TIMEOUT:
        'Local attachment preparation timed out. No inference request was sent.',
      ATTACHMENT_CORRUPT:
        'Attachment bytes do not match their immutable reference. No inference request was sent.',
      ATTACHMENT_TOO_LARGE:
        'Attachment history exceeds this source’s count or byte limits. Reduce attachments or start a new conversation.',
      ATTACHMENT_FILE_TYPE_UNSUPPORTED:
        'This file format is not enabled for direct model input. Use a supported document format or local file tools.',
      ATTACHMENT_MODEL_UNSUPPORTED:
        'The model catalog explicitly excludes this attachment input type.',
      ATTACHMENT_PROJECTION_CHANGED:
        'The native file projection changed. Transmission stopped instead of guessing a path from chat text.',
      MODEL_CATALOG_CHANGED:
        'The model catalog changed during request preparation. Reload the catalog and retry.',
      VERSION_MISMATCH:
        'The Host has not loaded the SIWC update. Restart DSH first; the legacy Codex sign-in was not started.',
    };
    const css = `
.cgs-card{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:16px;padding:22px;margin-top:16px;font:inherit;line-height:1.6}
.cgs-head,.cgs-row,.cgs-actions,.cgs-brand,.cgs-usage{display:flex;align-items:center;gap:10px}.cgs-head,.cgs-row{justify-content:space-between}.cgs-head{gap:20px}.cgs-brand{gap:12px}.cgs-logo{width:36px;height:36px;display:grid;place-items:center;background:#0b0b0b;border-radius:11px;flex-shrink:0}.cgs-logo img{width:26px;height:26px}.cgs-kicker{font-size:10px;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary)}.cgs-card h3{margin:0;font-size:17px;font-weight:600;letter-spacing:-.02em}.cgs-code{font:11px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary)}
.cgs-muted{font-size:13px;color:var(--dsw-alias-label-secondary);margin:12px 0}.cgs-small{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:10px 0 0}.cgs-actions{flex-wrap:wrap;margin-top:14px}.cgs-row .cgs-actions{margin:0;flex-shrink:0}.cgs-accounts{margin-top:18px;border-top:1px solid var(--dsw-alias-settings-card-stroke)}.cgs-row{padding:15px 0;gap:16px;border-bottom:1px solid var(--dsw-alias-settings-card-stroke);flex-wrap:wrap}.cgs-account{min-width:0;flex:1}.cgs-label{font-size:13px;font-weight:500;overflow-wrap:anywhere}.cgs-tag{font-size:11px;color:var(--dsw-alias-label-tertiary)}.cgs-tag[data-active=true]{color:var(--dsw-alias-state-success-primary)}.cgs-empty{padding:24px 0 16px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.cgs-button{font:inherit;font-size:12px;line-height:20px;border:1px solid var(--dsw-alias-border-l3);border-radius:9px;padding:6px 11px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:7px;white-space:nowrap}.cgs-button:hover{background:var(--dsw-alias-interactive-bg-hover)}.cgs-button[data-primary=true]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}.cgs-button.cgs-chatgpt{background:#0b0b0b;color:#fff;border-color:#0b0b0b;padding:9px 13px;font-size:13px}.cgs-chatgpt img{width:21px;height:21px}.cgs-chatgpt:hover{background:#2b2b2b}.cgs-button:disabled{opacity:.45;cursor:not-allowed}.cgs-button:focus-visible,.cgs-link:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px}.cgs-link{color:var(--dsw-alias-state-business-primary);font-size:12px;white-space:nowrap}
.cgs-notice{margin-top:14px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow-wrap:anywhere}.cgs-notice p:first-child{margin-top:0}.cgs-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:12px 0 0}.cgs-step{font-size:13px;font-weight:500}.cgs-footer{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-top:17px;flex-wrap:wrap}
.cgs-dialog{box-sizing:border-box;width:min(480px,calc(100vw - 32px));border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:18px;padding:28px;background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary);font:inherit;box-shadow:0 16px 70px #0003}.cgs-dialog::backdrop{background:#0006}.cgs-dialog h2{font-size:20px;letter-spacing:-.03em;margin:16px 0 12px}.cgs-dialog p{font-size:13px;line-height:1.8;color:var(--dsw-alias-label-secondary)}
.cgs-usage{font:inherit;font-size:11px;line-height:20px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap;padding:2px 4px}.cgs-usage a{font-size:11px}.cgs-usage-dot{width:5px;height:5px;background:var(--dsw-alias-state-success-primary);border-radius:50%}.cgs-limit{color:var(--dsw-alias-state-error-primary)}
@media(max-width:520px){.cgs-card{padding:17px}.cgs-head{align-items:flex-start;flex-wrap:wrap}.cgs-row{gap:9px}.cgs-row .cgs-actions{width:100%}.cgs-code{display:none}}
`;
    const code = (error) =>
      /^[A-Z0-9_]{1,64}$/.test(error?.message ?? '') ? error.message : 'network';
    const errorText = (t, value) => (value in zh ? t(value) : `${t('failed')} (${value})`);
    function useSource({ enabled = true, poll = 0 } = {}) {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const alive = React.useRef(false),
        requests = React.useRef(new Set()),
        serial = React.useRef(0),
        locked = React.useRef(false);
      const request = React.useCallback(async (body) => {
        const abort = new AbortController();
        requests.current.add(abort);
        const timer = setTimeout(() => abort.abort(), body?.action === 'logout' ? 65000 : 20000);
        try {
          const transport = globalThis.__DSH_TRANSPORT__?.fetch;
          const response = await (transport ?? globalThis.fetch.bind(globalThis))(
            'api/local-chatgpt-source',
            {
              method: body ? 'POST' : 'GET',
              cache: 'no-store',
              signal: abort.signal,
              ...(body
                ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
                : {}),
            },
          );
          const data = await response.json();
          if (!response.ok) throw new Error(data.error ?? 'network');
          if (data.protocol !== 'siwc' || data.provider !== 'chatgpt-subscription')
            throw new Error('VERSION_MISMATCH');
          return data;
        } finally {
          clearTimeout(timer);
          requests.current.delete(abort);
        }
      }, []);
      const refresh = React.useCallback(async () => {
        if (locked.current) return;
        const id = ++serial.current;
        try {
          const next = await request();
          if (alive.current && id === serial.current) {
            setState(next);
            setError('');
          }
        } catch (error) {
          if (alive.current && id === serial.current) setError(code(error));
        }
      }, [request]);
      React.useEffect(() => {
        if (!enabled) return;
        alive.current = true;
        void refresh();
        const focus = () => {
          void refresh();
        };
        window.addEventListener('focus', focus);
        return () => {
          alive.current = false;
          ++serial.current;
          window.removeEventListener('focus', focus);
          for (const request of requests.current) request.abort();
        };
      }, [enabled, refresh]);
      const running = ['starting', 'waiting', 'verifying'].includes(state?.attempt?.phase);
      const interval = running ? 850 : poll;
      React.useEffect(() => {
        if (!enabled || !interval || busy) return;
        let stopped = false,
          timer;
        const tick = async () => {
          await refresh();
          if (!stopped) timer = setTimeout(tick, interval);
        };
        timer = setTimeout(tick, interval);
        return () => {
          stopped = true;
          clearTimeout(timer);
        };
      }, [enabled, interval, busy, refresh]);
      const act = async (body) => {
        if (locked.current || !state) return;
        locked.current = true;
        setBusy(true);
        setError('');
        ++serial.current;
        try {
          const next = await request(body);
          if (alive.current) setState(next);
        } catch (error) {
          if (alive.current) setError(code(error));
        } finally {
          locked.current = false;
          if (alive.current) setBusy(false);
        }
      };
      return { state, error, busy, running, act, refresh };
    }
    const usage = (t, prominent = false) =>
      h(
        'a',
        {
          href: USAGE,
          target: '_blank',
          rel: 'noopener noreferrer',
          className: prominent ? 'cgs-button' : 'cgs-link',
        },
        t('manage'),
        ' ↗',
      );
    function Welcome({ account, t, busy, act }) {
      const dialog = React.useRef(null);
      React.useEffect(() => {
        const node = dialog.current;
        node?.showModal();
        return () => {
          if (node?.open) node.close();
        };
      }, []);
      return h(
        'dialog',
        {
          className: 'cgs-dialog',
          ref: dialog,
          'aria-labelledby': 'cgs-welcome-title',
          onCancel: (event) => {
            event.preventDefault();
            if (!busy) void act({ action: 'acknowledge', key: account.key });
          },
        },
        h('span', { className: 'cgs-logo' }, h('img', { src: LOGO, alt: '' })),
        h('h2', { id: 'cgs-welcome-title' }, t('welcomeTitle')),
        h('p', null, t('welcomeText')),
        h('p', null, t('welcomeHint')),
        h(
          'div',
          { className: 'cgs-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'cgs-button',
              'data-primary': true,
              autoFocus: true,
              disabled: busy,
              onClick: () => {
                void act({ action: 'acknowledge', key: account.key });
              },
            },
            t('gotIt'),
          ),
          usage(t),
        ),
      );
    }
    function Card({ t }) {
      const { state, error, busy, running, act, refresh } = useSource();
      const [confirm, setConfirm] = React.useState(null);
      const accounts = state?.accounts ?? [],
        attempt = state?.attempt;
      const welcome = accounts.find((account) => account.welcomeRequired);
      const button = (label, body, primary = false, disabled = false) =>
        h(
          'button',
          {
            type: 'button',
            className: 'cgs-button',
            'data-primary': primary,
            disabled: busy || disabled,
            onClick: () => {
              void act(body);
            },
          },
          label,
        );
      const status = (account) =>
        account.key === state?.selection?.key && account.inferenceEnabled
          ? 'active'
          : ({
              authorized: 'available',
              disabled: 'disabled',
              pending: 'pending',
              'signed-out': 'signedOut',
              'reauth-required': 'reauth',
            }[account.status] ?? 'reauth');
      let authorize;
      try {
        const url = new URL(attempt?.authorizeUrl);
        if (
          url.origin === 'https://auth.openai.com' &&
          url.pathname === '/api/accounts/authorize' &&
          !url.searchParams.has('id_token_hint')
        )
          authorize = url.href;
      } catch {
        /* No safe link until Host publishes one. */
      }
      return h(
        'section',
        { className: 'cgs-card', 'aria-label': t('title'), 'data-cgs-protocol': 'siwc' },
        h('style', null, css),
        h(
          'div',
          { className: 'cgs-head' },
          h(
            'div',
            { className: 'cgs-brand' },
            h('span', { className: 'cgs-logo' }, h('img', { src: LOGO, alt: '' })),
            h(
              'div',
              null,
              h('div', { className: 'cgs-kicker' }, t('subtitle')),
              h('h3', null, t('title')),
            ),
          ),
          usage(t),
        ),
        h('p', { className: 'cgs-muted' }, t('intro')),
        !state
          ? h('p', { className: 'cgs-muted', role: 'status' }, t('loading'))
          : h(
              React.Fragment,
              null,
              accounts.length
                ? h(
                    'div',
                    { className: 'cgs-accounts' },
                    ...accounts.map((account) =>
                      h(
                        'div',
                        { className: 'cgs-row', key: account.key },
                        h(
                          'div',
                          { className: 'cgs-account' },
                          h('div', { className: 'cgs-label' }, account.label),
                          h(
                            'span',
                            { className: 'cgs-tag', 'data-active': status(account) === 'active' },
                            t(status(account)),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'cgs-actions' },
                          account.inferenceEnabled &&
                            button(
                              t(status(account) === 'active' ? 'active' : 'choose'),
                              { action: 'select', key: account.key },
                              status(account) !== 'active',
                              running || status(account) === 'active',
                            ),
                          account.status === 'disabled'
                            ? button(
                                t('enable'),
                                { action: 'start', key: account.key, enablePlanUsage: true },
                                true,
                                running,
                              )
                            : button(
                                t('signAgain'),
                                { action: 'start', key: account.key },
                                false,
                                running,
                              ),
                          account.signedIn &&
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'cgs-button',
                                disabled: busy || running,
                                onClick: () => setConfirm(account),
                              },
                              t('logout'),
                            ),
                        ),
                      ),
                    ),
                  )
                : h(
                    'div',
                    { className: 'cgs-empty' },
                    t('empty'),
                    h('div', { className: 'cgs-small' }, t('emptyHint')),
                  ),
              running &&
                h(
                  'div',
                  { className: 'cgs-notice', role: 'status', 'aria-live': 'polite' },
                  h(
                    'div',
                    { className: 'cgs-step' },
                    t(attempt.phase === 'verifying' ? 'verifying' : 'opening'),
                  ),
                  h('p', { className: 'cgs-muted' }, t('waitingHint')),
                  h(
                    'div',
                    { className: 'cgs-actions' },
                    authorize &&
                      h(
                        'a',
                        {
                          className: 'cgs-button',
                          'data-primary': true,
                          href: authorize,
                          target: '_blank',
                          rel: 'noopener noreferrer',
                        },
                        t('browser'),
                        ' ↗',
                      ),
                    button(t('cancel'), { action: 'cancel', attemptId: attempt.id }),
                  ),
                  authorize && h('div', { className: 'cgs-small' }, t('secure')),
                ),
              !running &&
                attempt?.phase === 'authorized' &&
                h(
                  'p',
                  { className: 'cgs-muted', role: 'status' },
                  t(attempt.directEnabled ? 'authorized' : 'signedOnly'),
                ),
              ['cancelled', 'expired'].includes(attempt?.phase) &&
                h('p', { className: 'cgs-muted', role: 'status' }, t(attempt.phase)),
              attempt?.error &&
                h('p', { className: 'cgs-error', role: 'alert' }, errorText(t, attempt.error)),
              !running &&
                h(
                  'div',
                  { className: 'cgs-footer' },
                  h(
                    'div',
                    null,
                    accounts.length > 0 &&
                      h(
                        'div',
                        { className: 'cgs-small', style: { margin: '0 0 7px' } },
                        t('addHint'),
                      ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'cgs-button cgs-chatgpt',
                        disabled: busy,
                        onClick: () => {
                          void act({ action: 'start' });
                        },
                      },
                      h('img', { src: LOGO, alt: '' }),
                      t('continue'),
                    ),
                  ),
                  h('code', { className: 'cgs-code' }, t('source')),
                ),
              h('p', { className: 'cgs-small' }, t('selectHint')),
              confirm &&
                h(
                  'div',
                  { className: 'cgs-notice' },
                  h('div', { className: 'cgs-step' }, t('confirmTitle')),
                  h('p', { className: 'cgs-muted' }, confirm.label, ' — ', t('confirmText')),
                  h(
                    'div',
                    { className: 'cgs-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'cgs-button',
                        disabled: busy,
                        onClick: () => setConfirm(null),
                      },
                      t('back'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'cgs-button',
                        disabled: busy,
                        onClick: async () => {
                          await act({ action: 'logout', key: confirm.key });
                          setConfirm(null);
                        },
                      },
                      t('confirm'),
                    ),
                  ),
                ),
              state.logout?.warning &&
                h(
                  'div',
                  { className: 'cgs-notice', role: 'alert' },
                  h('p', { className: 'cgs-muted' }, t('remoteUnknown')),
                  usage(t, true),
                ),
            ),
        error && h('p', { className: 'cgs-error', role: 'alert' }, errorText(t, error)),
        h(
          'div',
          { className: 'cgs-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'cgs-button',
              disabled: busy,
              onClick: () => {
                void refresh();
              },
            },
            t('refresh'),
          ),
        ),
        h('p', { className: 'cgs-small' }, t('limits')),
        h('p', { className: 'cgs-small' }, t('preview')),
        welcome && h(Welcome, { key: welcome.key, account: welcome, t, busy, act }),
      );
    }
    function PlanBadge({ directory, t }) {
      const subscribe = React.useCallback((callback) => directory.subscribe(callback), [directory]);
      const getSnapshot = React.useCallback(() => directory.getSnapshot(), [directory]);
      const selected = React.useSyncExternalStore(subscribe, getSnapshot);
      const visible = selected.current?.provider === 'chatgpt-subscription';
      const { state } = useSource({ enabled: visible, poll: 3000 });
      if (!visible) return null;
      const enabled = state?.accounts?.some(
        (account) => account.key === state.selection?.key && account.inferenceEnabled,
      );
      const quota = state?.notice?.code === 'QUOTA';
      return h(
        React.Fragment,
        null,
        h('style', null, css),
        h(
          'div',
          { className: `cgs-usage${quota ? ' cgs-limit' : ''}`, role: 'status' },
          h('span', { className: 'cgs-usage-dot' }),
          t(quota ? 'quota' : enabled ? 'usingPlan' : 'needsAccount'),
          usage(t, quota),
        ),
      );
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        for (const [service, methods] of [
          ['slots', ['inject', 'register']],
          ['locale', ['register', 'bind']],
        ])
          for (const method of methods)
            if (typeof ctx[service]?.[method] !== 'function')
              throw new Error(`DSH_CLIENT_CONTRACT_MISSING:${service}.${method}`);
        for (const method of ['effect', 'inject'])
          if (typeof ctx[method] !== 'function')
            throw new Error(`DSH_CLIENT_CONTRACT_MISSING:context.${method}`);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'chatgpt-subscription: locale');
        ctx.slots.inject('settings.models.footer', () =>
          ctx.slots.register(
            {
              name: 'settings.models.footer',
              id: 'chatgpt-subscription-login',
              order: 10,
              inject: () => ({ t: ctx.locale.bind(NS) }),
            },
            Card,
          ),
        );
        ctx.inject(['modelDirectories'], (scope) => {
          if (typeof scope.modelDirectories?.directoryFor !== 'function')
            throw new Error('DSH_CLIENT_CONTRACT_MISSING:modelDirectories.directoryFor');
          scope.slots.inject('conversation.composer.dock', () =>
            scope.slots.register(
              {
                name: 'conversation.composer.dock',
                id: 'chatgpt-plan-usage',
                order: 15,
                inject: (sessionId) => ({
                  directory: scope.modelDirectories.directoryFor(sessionId).store,
                  t: ctx.locale.bind(NS),
                }),
              },
              PlanBadge,
            ),
          );
        });
      },
    };
  },
});
