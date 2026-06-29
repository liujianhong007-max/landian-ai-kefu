'use strict';

(function bootstrapLogin() {
  const doc = typeof document !== 'undefined' ? document : null;
  const api = typeof window !== 'undefined' ? (window.pddFuke || {}) : {};

  function byId(id) {
    return doc && typeof doc.getElementById === 'function' ? doc.getElementById(id) : null;
  }

  const els = {
    loginForm: byId('loginForm'),
    phoneInput: byId('phoneInput'),
    passwordInput: byId('passwordInput'),
    loginButton: byId('loginButton'),
    loginError: byId('loginError'),
    loginSubtitle: byId('loginSubtitle'),
    footerText: byId('footerText'),
    toggleModeButton: byId('toggleModeButton'),
    rememberCheckbox: byId('rememberCheckbox')
  };

  // mode: 'login' 或 'register'
  let mode = 'login';

  function showError(message) {
    if (!els.loginError) return;
    els.loginError.textContent = String(message || '');
    els.loginError.hidden = false;
  }

  function hideError() {
    if (!els.loginError) return;
    els.loginError.textContent = '';
    els.loginError.hidden = true;
  }

  function setLoading(loading) {
    if (els.loginButton) {
      els.loginButton.disabled = Boolean(loading);
      if (mode === 'login') {
        els.loginButton.textContent = loading ? '登录中...' : '登 录';
      } else {
        els.loginButton.textContent = loading ? '注册中...' : '注 册';
      }
    }
  }

  function switchMode() {
    hideError();
    if (mode === 'login') {
      mode = 'register';
      if (els.loginSubtitle) els.loginSubtitle.textContent = '注册新账号';
      if (els.loginButton) els.loginButton.textContent = '注 册';
      if (els.footerText) els.footerText.textContent = '已有账号？';
      if (els.toggleModeButton) els.toggleModeButton.textContent = '立即登录';
      if (els.passwordInput) els.passwordInput.placeholder = '请设置密码（6-128位）';
    } else {
      mode = 'login';
      if (els.loginSubtitle) els.loginSubtitle.textContent = '登录您的账号';
      if (els.loginButton) els.loginButton.textContent = '登 录';
      if (els.footerText) els.footerText.textContent = '还没有账号？';
      if (els.toggleModeButton) els.toggleModeButton.textContent = '立即注册';
      if (els.passwordInput) els.passwordInput.placeholder = '请输入密码';
    }
  }

  function isPhone(value) {
    const phone = String(value || '').trim();
    return /^1[3-9]\d{9}$/.test(phone);
  }

  async function handleSubmit(event) {
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }

    hideError();

    const phone = String(els.phoneInput?.value || '').trim();
    const password = String(els.passwordInput?.value || '').trim();
    const remember = els.rememberCheckbox?.checked || false;

    if (!isPhone(phone)) {
      showError('请输入正确的11位手机号');
      return;
    }

    if (!password) {
      showError('请输入密码');
      return;
    }

    if (mode === 'register' && password.length < 6) {
      showError('密码至少6位');
      return;
    }

    setLoading(true);

    try {
      let result;
      if (mode === 'login') {
        result = await api.login({ mobile: phone, password });
      } else {
        result = await api.register({ mobile: phone, password });
      }

      if (result?.token) {
        // 保存/删除自动登录凭据
        if (remember) {
          await api.saveCredentials({ mobile: phone, password, timestamp: Date.now() });
        } else {
          await api.clearCredentials();
        }

        // 登录/注册成功，通知主进程
        await api.notifyLoginSuccess({ token: result.token, user: result.user });
        // 关闭登录窗口
        await api.closeLogin();
      } else {
        showError(mode === 'login' ? '登录失败，请重试' : '注册失败，请重试');
      }
    } catch (error) {
      showError(error?.message || '网络错误，请稍后重试');
    } finally {
      setLoading(false);
    }
  }

  function bindEvents() {
    if (els.loginForm) {
      els.loginForm.addEventListener('submit', handleSubmit);
    }
    if (els.toggleModeButton) {
      els.toggleModeButton.addEventListener('click', switchMode);
    }
    // 窗口控制按钮
    var btnMinimize = byId('btnMinimize');
    var btnClose = byId('btnClose');
    if (btnMinimize) btnMinimize.addEventListener('click', function () { api.minimizeWindow?.(); });
    if (btnClose) btnClose.addEventListener('click', function () { api.closeWindow?.(); });
  }

  bindEvents();

  // 页面加载时，检查是否有已保存的自动登录凭据（7天内有效）
  (async function autoFillCredentials() {
    try {
      const saved = await api.getSavedCredentials?.();
      if (saved && saved.mobile && saved.password && saved.timestamp) {
        const now = Date.now();
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        if (now - saved.timestamp < sevenDays) {
          // 7天内，自动填充账号密码，勾选自动登录
          if (els.phoneInput) els.phoneInput.value = saved.mobile;
          if (els.passwordInput) els.passwordInput.value = saved.password;
          if (els.rememberCheckbox) els.rememberCheckbox.checked = true;
        } else {
          // 超过7天，清除过期凭据
          await api.clearCredentials?.();
        }
      }
    } catch (_) {
      // 静默忽略
    }
  })();
})();
