/**
 * 认证模块
 * 处理用户登录、注册、权限等相关功能
 */

// 用户认证状态
let currentUser = null;
let isAuthenticated = false;

// 心跳定时器（全局可访问）
let heartbeatInterval = null;
// 确保全局可访问
if (typeof window !== 'undefined') {
    window.heartbeatInterval = heartbeatInterval;
}

/**
 * 获取当前登录用户信息
 */
function getCurrentUser() {
    if (!currentUser || !isAuthenticated) {
        return null;
    }
    return currentUser;
}

/**
 * 权限检查函数
 */
function hasPermission(permissionKey) {
    // 超级管理员拥有所有权限
    if (currentUser && currentUser.role === 'admin') {
        return true;
    }
    // 普通用户根据权限配置判断
    if (currentUser && currentUser.permissions) {
        return Boolean(currentUser.permissions[permissionKey]);
    }
    // 未登录用户或无权限配置，默认无权限
    return false;
}

/**
 * 获取客户端IP地址
 */
async function getClientIP() {
    try {
        const response = await fetch('https://api.ipify.org?format=json');
        const data = await response.json();
        return data.ip;
    } catch (e) {
        return '未知IP';
    }
}

/**
 * 记录登录日志
 */
async function logUserLogin(user) {
    const ip = await getClientIP();
    
    // 1. 插入登录历史表
    const { error: logError } = await supabaseClient
        .from('login_history')
        .insert([{
            user_id: user.id,
            username: user.username || user.user_metadata?.username,
            email: user.email,
            role: user.role || 'user',
            ip_address: ip,
            login_at: new Date().toISOString()
        }]);

    if (logError) console.error('记录登录日志失败:', logError);

    // 2. 立即更新 users_v2 表的活跃时间
    await updateUserHeartbeat(user.id);
}

/**
 * 更新用户心跳 (保活)
 */
async function updateUserHeartbeat(userId) {
    if (!userId) return;
    const { error } = await supabaseClient
        .from('users_v2')
        .update({ last_active_at: new Date().toISOString() })
        .eq('id', userId);
        
    if (error) console.error('心跳更新失败:', error);
}

/**
 * 启动心跳定时器
 */
function startHeartbeat(userId) {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (typeof window !== 'undefined' && window.heartbeatInterval) {
        clearInterval(window.heartbeatInterval);
    }
    
    // 立即执行一次
    updateUserHeartbeat(userId);
    
    // 每 2 分钟执行一次 (300000ms)
    heartbeatInterval = setInterval(() => {
        updateUserHeartbeat(userId);
    }, 300000);
    
    // 同步到全局
    if (typeof window !== 'undefined') {
        window.heartbeatInterval = heartbeatInterval;
    }
}

/**
 * 初始化认证
 */
function initAuth() {
    checkUserSession();
    supabaseClient.auth.onAuthStateChange((event, session) => {
        handleAuthChange(event, session);
    });
}

/**
 * 检查用户会话
 */
async function checkUserSession() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
        handleAuthChange('SIGNED_IN', session);
    } else {
        document.getElementById('login-container').classList.remove('hidden');
    }
}

/**
 * 处理认证状态变化
 */
async function handleAuthChange(event, session) {
    if (event === 'SIGNED_IN' && session) {
        // 获取完整用户信息，包括角色
        try {
            const { data: userData, error } = await supabaseClient
                .from('users_v2')
                .select('*')
                .eq('id', session.user.id)
                .single();
            
            if (error) {
                console.error('获取用户角色失败:', error);
                
                // 针对42P17错误（无限递归策略）进行特殊处理
                if (error.code === '42P17') {
                    console.error('数据库策略存在无限递归问题，请检查users_v2表的RLS策略');
                    showToast('数据库策略存在问题，无法获取用户角色', 'error');
                }
                
                // 降级处理：使用 session 中的元数据
                currentUser = {
                    ...session.user,
                    role: session.user.user_metadata?.role || 'user',
                    username: session.user.user_metadata?.username || '用户',
                    status: 'active',
                    permissions: session.user.user_metadata?.permissions || {}
                };
            } else {
                // 正常获取：使用数据库数据
                currentUser = {
                    ...session.user,
                    role: userData.role,
                    username: userData.username || session.user.user_metadata?.username || '用户',
                    status: userData.status,
                    permissions: userData.permissions || {}
                };
            }
        } catch (error) {
            console.error('获取用户信息时发生错误:', error);
            currentUser = {
                ...session.user,
                permissions: session.user.user_metadata?.permissions || {}
            };
        }
        
        isAuthenticated = true;
        document.getElementById('login-container').classList.add('hidden');
        
        // 更新侧边栏用户信息
        const userInfo = document.getElementById('user-info');
        const userNameEl = document.getElementById('user-name');
        const userEmailEl = document.getElementById('user-email');
        const userRoleEl = document.getElementById('user-role-label');
        
        userInfo.classList.remove('hidden');
        userNameEl.textContent = currentUser.username || '用户';
        userNameEl.title = currentUser.username;
        userEmailEl.textContent = currentUser.email;
        userEmailEl.title = currentUser.email;
        
        if (userRoleEl) {
            if (currentUser.role === 'admin') {
                userRoleEl.textContent = '管理员账号';
                userRoleEl.className = 'text-[10px] px-1.5 py-0.5 rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 font-medium whitespace-nowrap';
                document.getElementById('nav-users').classList.remove('hidden');
            } else {
                userRoleEl.textContent = '成员账号';
                userRoleEl.className = 'text-[10px] px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap';
                document.getElementById('nav-users').classList.add('hidden');
            }
        }
        
        // 初始化数据
        database = await loadDataFromSupabase();
        renderTableHeader();
        renderColumnModal();
        renderKanban();
        initCharts();
        fetchTableData();
        
        // 启动心跳机制
        startHeartbeat(session.user.id);
        
        const loginContainer = document.getElementById('login-container');
        if (loginContainer && loginContainer.classList.contains('hidden') === false) {
            showToast('登录成功！', 'success');
        }
    } else if (event === 'SIGNED_OUT') {
        // 停止心跳
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (typeof window !== 'undefined' && window.heartbeatInterval) {
            clearInterval(window.heartbeatInterval);
            window.heartbeatInterval = null;
        }
        currentUser = null;
        isAuthenticated = false;
        document.getElementById('user-info').classList.add('hidden');
        database = [];
        document.getElementById('login-container').classList.remove('hidden');
    }
}

/**
 * 处理登录
 */
async function handleLogin() {
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    try {
        const { error, data } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) {
            handleError(error, '登录');
        } else {
            if (data.user) {
                const { data: userDetails } = await supabaseClient
                    .from('users_v2')
                    .select('*')
                    .eq('id', data.user.id)
                    .single();
                    
                const userInfo = {
                    ...data.user,
                    username: userDetails?.username || '用户',
                    role: userDetails?.role || 'user'
                };
                
                // 异步记录，不阻塞跳转
                logUserLogin(userInfo);
            }
        }
    } catch (error) {
        handleError(error, '登录');
    }
}

/**
 * 处理注册
 */
async function handleRegister() {
    showToast('注册功能已关闭，请联系管理员获取账号', 'info');
    return;
}

/**
 * 处理密码重置
 */
async function handlePasswordReset() {
    showToast('密码重置功能已关闭，请联系管理员重置密码', 'info');
    return;
}

/**
 * 登出功能
 */
function handleLogout() {
    supabaseClient.auth.signOut();
}

