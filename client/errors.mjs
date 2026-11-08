// Only known backend tokens become user-facing text; RPC wrappers and arbitrary messages stay private.
const messages = {
    'login-required': '需要登录 B站，请打开官方登录窗口并检查登录',
    'risk-control': 'B站暂时触发风控，请稍后重试',
    unavailable: '视频不可用，可能已删除、设为私密或受地区限制',
    network: '网络连接失败，请检查网络后重试',
    timeout: '请求超时，请稍后重试',
    'unsupported-media': '不支持此视频格式或编码，请选择其他视频',
    'invalid-response': 'B站返回的数据无效，请稍后重试',
    'credential-storage': '凭据安全存储不可用，请检查系统安全存储后重试',
    stopped: '服务已停止，请重新启用模组',
    'auth-changed': '账号状态已变化，请点击“重试播放”',
};
export function errorText(error, operation) {
    const text = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
    const token = /(?:^|[^A-Za-z0-9_-])bili:(login-required|risk-control|unavailable|network|timeout|unsupported-media|invalid-response|credential-storage|stopped|auth-changed)(?![A-Za-z0-9_-])/.exec(text)?.[1];
    return `${operation}失败：${messages[token] ?? '发生错误，请重试'}`;
}
export function mediaErrorText(code) {
    if (code === 2) return '视频网络加载失败，请检查网络后点击“重试播放”';
    if (code === 3) return '视频解码失败，当前浏览器可能不支持该编码，请尝试其他视频';
    if (code === 4) return '视频源格式或编码不受支持，请尝试其他视频';
    return 'MV 播放失败，请点击“重试播放”';
}
