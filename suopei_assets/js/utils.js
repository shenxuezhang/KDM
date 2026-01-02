/**
 * 工具函数模块
 * 包含通用工具函数、格式化函数等
 */

// ============================================
// 防抖和节流工具函数
// ============================================

/**
 * 防抖函数 - 延迟执行，频繁调用时只执行最后一次
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func.apply(this, args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * 节流函数 - 限制执行频率，定期执行
 */
function throttle(func, limit) {
    let inThrottle;
    return function executedFunction(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

// ============================================
// DOM元素缓存工具
// ============================================

/**
 * DOM元素查询缓存器
 * 避免重复查询相同的DOM元素
 */
const $ = {
    cache: new Map(),
    
    get(id) {
        if (this.cache.has(id)) {
            const element = this.cache.get(id);
            // 检查元素是否还在DOM中
            if (document.contains(element)) {
                return element;
            } else {
                // 元素已被移除，清除缓存
                this.cache.delete(id);
            }
        }
        
        const element = document.getElementById(id);
        if (element) {
            this.cache.set(id, element);
        }
        return element;
    },
    
    clear() {
        this.cache.clear();
    },
    
    remove(id) {
        this.cache.delete(id);
    }
};

// ============================================
// 统一的错误处理函数
// ============================================

/**
 * 统一的错误处理函数
 * @param {Error} error - 错误对象
 * @param {string} context - 操作上下文（用于错误提示）
 */
function handleError(error, context = '操作') {
    let userMessage = `${context}失败`;
    
    // 根据错误类型提供更友好的提示
    if (error.message) {
        if (error.message.includes('network') || error.message.includes('fetch')) {
            userMessage = '网络连接失败，请检查网络后重试';
        } else if (error.message.includes('timeout')) {
            userMessage = '请求超时，请稍后重试';
        } else if (error.message.includes('permission') || error.message.includes('unauthorized')) {
            userMessage = '权限不足，无法执行此操作';
        } else if (error.message.includes('User already registered')) {
            userMessage = '该邮箱已被注册';
        } else {
            userMessage = `${context}失败: ${error.message}`;
        }
    }
    
    showToast(userMessage, 'error');
    
    // 如果是关键错误，可以上报到监控系统
    if (error.code === '42P17' || error.message && error.message.includes('database')) {
        // 这里可以添加错误上报逻辑
    }
}

// ============================================
// 格式化函数
// ============================================

/**
 * 格式化日期显示 (仅日期，YYYY-MM-DD) - 用于发货日期、申请提交日期等
 */
function formatDateDisplay(isoString) {
    if (!isoString) return '';
    
    // 如果已经是 YYYY-MM-DD 格式，直接返回
    if (typeof isoString === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(isoString)) {
        return isoString;
    }
    
    const date = new Date(isoString);
    if (isNaN(date.getTime())) {
        // 如果解析失败，尝试提取日期部分
        if (typeof isoString === 'string' && isoString.length >= 10) {
            return isoString.substring(0, 10);
        }
        return isoString;
    }

    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    
    return `${y}-${m}-${d}`;
}

/**
 * 格式化日期时间显示 (YYYY-MM-DD HH:mm:ss) - 用于需要显示时间的场景
 */
function formatDateTimeDisplay(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;

    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    
    return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

/**
 * 格式化UTC时间为本地时区的YYYY-MM-DD HH:mm:ss格式
 */
function formatLocalTime(utcString) {
    if (!utcString) return '';
    const date = new Date(utcString);
    return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).replace(/\//g, '-'); // 将斜杠替换为横杠，确保格式为YYYY-MM-DD
}

/**
 * 格式化相对时间
 */
function formatRelativeTime(dateString) {
    const now = new Date();
    const date = new Date(dateString);
    const diffMinutes = Math.floor((now - date) / (1000 * 60));
    
    if (diffMinutes < 1) return '刚刚';
    if (diffMinutes < 60) return `${diffMinutes}分钟前`;
    if (diffMinutes < 1440) return `${Math.floor(diffMinutes / 60)}小时前`;
    return `${Math.floor(diffMinutes / 1440)}天前`;
}

// ============================================
// UUID生成
// ============================================

/**
 * 生成UUID
 */
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// ============================================
// 数据清洗函数
// ============================================

/**
 * 清洗数据，只保留数据库允许的字段
 */
function sanitizeDataForSupabase(data) {
    const cleanData = {};
    // 使用全局的 DB_ALLOWED_COLUMNS（在 config.js 中定义）
    // 优先使用全局变量，如果没有则使用模块变量
    const allowedColumns = (typeof window !== 'undefined' && window.DB_ALLOWED_COLUMNS) 
        ? window.DB_ALLOWED_COLUMNS 
        : (typeof DB_ALLOWED_COLUMNS !== 'undefined' ? DB_ALLOWED_COLUMNS : []);
    
    allowedColumns.forEach(key => {
        // 保留字段，即使值为 null 或空字符串也要保留（但排除 undefined）
        if (data.hasOwnProperty(key) && data[key] !== undefined) {
            cleanData[key] = data[key];
        }
    });
    return cleanData;
}

// 将 sanitizeDataForSupabase 暴露到全局，供 HTML 中的代码调用
if (typeof window !== 'undefined') {
    window.sanitizeDataForSupabase = sanitizeDataForSupabase;
}

