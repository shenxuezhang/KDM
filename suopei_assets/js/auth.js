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

// 定时器管理器（内存泄漏修复）
const TimerManager = {
    timers: new Set(),
    
    /**
     * 添加定时器
     * @param {number} timerId - 定时器ID
     */
    add(timerId) {
        this.timers.add(timerId);
    },
    
    /**
     * 移除定时器
     * @param {number} timerId - 定时器ID
     */
    remove(timerId) {
        if (this.timers.has(timerId)) {
            clearInterval(timerId);
            this.timers.delete(timerId);
        }
    },
    
    /**
     * 清理所有定时器
     */
    clear() {
        this.timers.forEach(timerId => {
            clearInterval(timerId);
        });
        this.timers.clear();
    }
};

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
        
}

/**
 * 启动心跳定时器
 */
function startHeartbeat(userId) {
    // 清理旧的定时器
    if (heartbeatInterval) {
        TimerManager.remove(heartbeatInterval);
        heartbeatInterval = null;
    }
    if (typeof window !== 'undefined' && window.heartbeatInterval) {
        TimerManager.remove(window.heartbeatInterval);
        window.heartbeatInterval = null;
    }
    
    // 立即执行一次
    updateUserHeartbeat(userId);
    
    let lastActivityTime = Date.now();
    
    // 监听用户活动
    function resetActivityTimer() {
        lastActivityTime = Date.now();
    }
    
    // 添加活动监听器
    document.addEventListener('mousemove', resetActivityTimer);
    document.addEventListener('keydown', resetActivityTimer);
    document.addEventListener('scroll', resetActivityTimer);
    
    // 创建智能心跳定时器
    heartbeatInterval = setInterval(() => {
        const now = Date.now();
        const idleTime = now - lastActivityTime;
        
        // 根据空闲时间动态调整心跳频率
        if (idleTime < 300000) { // 5分钟内有活动
            updateUserHeartbeat(userId);
        } else if (idleTime < 1800000) { // 5-30分钟空闲
            // 每15分钟发送一次心跳
            if (Math.random() < 0.33) {
                updateUserHeartbeat(userId);
            }
        } else {
            // 超过30分钟空闲，停止心跳
            TimerManager.remove(heartbeatInterval);
            heartbeatInterval = null;
            if (typeof window !== 'undefined') {
                window.heartbeatInterval = null;
            }
        }
    }, 300000); // 仍然保持5分钟检查间隔
    
    TimerManager.add(heartbeatInterval);
    
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
    
    // 添加页面可见性监听
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            // 页面隐藏时，停止心跳
            if (heartbeatInterval) {
                TimerManager.remove(heartbeatInterval);
                heartbeatInterval = null;
            }
            if (typeof window !== 'undefined' && window.heartbeatInterval) {
                window.heartbeatInterval = null;
            }
        } else {
            // 页面可见时，恢复心跳
            if (currentUser && currentUser.id) {
                startHeartbeat(currentUser.id);
            }
        }
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
                // 针对42P17错误（无限递归策略）进行特殊处理
                if (error.code === '42P17') {
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
        
        // 【修复】检查当前视图，避免在用户管理页面等非数据视图触发数据加载
        const currentView = localStorage.getItem('wh_claims_currentView') || 'form';
        const isDataRelatedView = ['form', 'data', 'kanban'].includes(currentView);
        
        // 只在数据相关视图初始化数据
        if (isDataRelatedView) {
            // 初始化数据
            database = await loadDataFromSupabase();
            renderTableHeader();
            renderColumnModal();
            renderKanban();
            initCharts();
            fetchTableData();
        }
        
        // 【数据缓存机制增强】缓存预热：提前加载常用查询条件的数据
        if (typeof window.warmupCache === 'function') {
            setTimeout(() => {
                window.warmupCache();
            }, 2000); // 延迟2秒执行，不阻塞初始加载
        }
        
        // 启动心跳机制
        startHeartbeat(session.user.id);
        
        // 启动实时数据同步
        if (typeof initRealtimeSubscription === 'function') {
            initRealtimeSubscription();
        }
        
        // 恢复之前打开的视图
        const savedView = localStorage.getItem('wh_claims_currentView') || 'form';
        if (typeof switchView === 'function') {
            await switchView(savedView);
        } else if (typeof window.switchView === 'function') {
            await window.switchView(savedView);
        } else {
            // 如果switchView还未加载，等待一下
            setTimeout(async () => {
                if (typeof window.switchView === 'function') {
                    await window.switchView(savedView);
                }
            }, 100);
        }
        
        const loginContainer = document.getElementById('login-container');
        if (loginContainer && loginContainer.classList.contains('hidden') === false) {
            showToast('登录成功！', 'success');
        }
    } else if (event === 'SIGNED_OUT') {
        // 停止实时数据同步
        if (typeof stopRealtimeSubscription === 'function') {
            stopRealtimeSubscription();
        }
        
        // 停止心跳并清理所有定时器
        TimerManager.clear();
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
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
    // 清理所有定时器
    TimerManager.clear();
    
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    if (typeof window !== 'undefined' && window.heartbeatInterval) {
        clearInterval(window.heartbeatInterval);
        window.heartbeatInterval = null;
    }
    
    supabaseClient.auth.signOut();
}

