/**
 * 数据库操作模块
 * 处理与Supabase数据库的所有交互
 */

// 数据库连接状态管理
let dbConnectionState = 'connected'; // connected, connecting, error

// 数据获取竞态条件控制变量
let currentFetchController = null;
let fetchRequestId = 0;

// 全局数据库数组（兼容旧版，用于缓存）
let database = [];

// 【数据缓存机制增强】多级缓存策略：内存缓存 + localStorage 持久化备份
const requestCache = new Map(); // 内存缓存（一级缓存）
const CACHE_TTL = 30000; // 缓存有效期：30秒
const MAX_CACHE_SIZE = 50; // 最大缓存条目数
const LOCALSTORAGE_CACHE_PREFIX = 'wh_claims_cache_'; // localStorage缓存键前缀
const LOCALSTORAGE_CACHE_TTL = 300000; // localStorage缓存有效期：5分钟
const MAX_LOCALSTORAGE_CACHE_SIZE = 20; // localStorage最大缓存条目数

// 【数据缓存机制增强】缓存命中统计
const cacheStats = {
    memoryHits: 0,      // 内存缓存命中次数
    localStorageHits: 0, // localStorage缓存命中次数
    misses: 0,          // 缓存未命中次数
    totalRequests: 0    // 总请求次数
};

// 【性能优化】生成缓存键
// 【修复】包含advancedFilters，确保筛选条件变化时使用不同的缓存键
function getCacheKey(page, pageSize, filters, sorting) {
    return JSON.stringify({
        page,
        pageSize,
        status: filters.status,
        type: filters.type,
        search: filters.search,
        searchMode: filters.searchMode,
        searchField: filters.searchField,
        advancedFilters: filters.advancedFilters, // 【修复】包含高级筛选条件
        // 【清理】advancedSearch 已废弃，不再使用
        col: sorting.col,
        asc: sorting.asc
    });
}

/**
 * 【数据缓存机制增强】从localStorage获取缓存
 */
function getCacheFromLocalStorage(cacheKey) {
    try {
        const stored = localStorage.getItem(LOCALSTORAGE_CACHE_PREFIX + cacheKey);
        if (!stored) return null;
        
        const cacheData = JSON.parse(stored);
        const now = Date.now();
        
        // 检查是否过期
        if (now - cacheData.timestamp > LOCALSTORAGE_CACHE_TTL) {
            localStorage.removeItem(LOCALSTORAGE_CACHE_PREFIX + cacheKey);
            return null;
        }
        
        return cacheData;
    } catch (error) {
        return null;
    }
}

/**
 * 【数据缓存机制增强】保存缓存到localStorage
 */
function saveCacheToLocalStorage(cacheKey, data, totalCount) {
    try {
        const cacheData = {
            data,
            totalCount,
            timestamp: Date.now()
        };
        
        // 清理过期和多余的localStorage缓存
        cleanLocalStorageCache();
        
        localStorage.setItem(LOCALSTORAGE_CACHE_PREFIX + cacheKey, JSON.stringify(cacheData));
    } catch (error) {
        // localStorage可能已满，尝试清理后重试
        if (error.name === 'QuotaExceededError') {
            cleanLocalStorageCache(true);
            try {
                localStorage.setItem(LOCALSTORAGE_CACHE_PREFIX + cacheKey, JSON.stringify({
                    data,
                    totalCount,
                    timestamp: Date.now()
                }));
            } catch (retryError) {
                // 保存localStorage缓存失败（已尝试清理），静默处理
            }
        } else {
            // 保存localStorage缓存失败，静默处理
        }
    }
}

/**
 * 【数据缓存机制增强】清理localStorage缓存
 */
function cleanLocalStorageCache(forceClean = false) {
    try {
        const keys = Object.keys(localStorage);
        const cacheKeys = keys.filter(key => key.startsWith(LOCALSTORAGE_CACHE_PREFIX));
        const now = Date.now();
        const cacheEntries = [];
        
        // 收集所有缓存条目，包括时间戳信息
        cacheKeys.forEach(key => {
            try {
                const stored = localStorage.getItem(key);
                if (stored) {
                    const cacheData = JSON.parse(stored);
                    // 检查是否过期
                    if (now - cacheData.timestamp > LOCALSTORAGE_CACHE_TTL) {
                        localStorage.removeItem(key);
                    } else {
                        cacheEntries.push({ key, timestamp: cacheData.timestamp });
                    }
                }
            } catch (error) {
                // 无效的缓存条目，删除
                localStorage.removeItem(key);
            }
        });
        
        // LRU策略：如果缓存条目过多，删除最久未访问的
        if (cacheEntries.length > MAX_LOCALSTORAGE_CACHE_SIZE || forceClean) {
            cacheEntries.sort((a, b) => a.timestamp - b.timestamp);
            const toDelete = cacheEntries.slice(0, Math.max(0, cacheEntries.length - MAX_LOCALSTORAGE_CACHE_SIZE + (forceClean ? 5 : 0)));
            toDelete.forEach(({ key }) => localStorage.removeItem(key));
        }
    } catch (error) {
        // 清理localStorage缓存失败，静默处理
    }
}

/**
 * 【数据缓存机制增强】LRU缓存清理策略（改进版）
 * 优先清理最久未访问的缓存条目
 */
function cleanExpiredCache() {
    const now = Date.now();
    
    // 第一步：清理过期的内存缓存
    for (const [key, value] of requestCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            requestCache.delete(key);
        }
    }
    
    // 第二步：LRU策略 - 如果缓存仍然过大，删除最久未访问的条目
    if (requestCache.size > MAX_CACHE_SIZE) {
        // 按访问时间排序，删除最旧的
        const sortedEntries = Array.from(requestCache.entries())
            .sort((a, b) => (a[1].lastAccessed || a[1].timestamp) - (b[1].lastAccessed || b[1].timestamp));
        const toDelete = sortedEntries.slice(0, requestCache.size - MAX_CACHE_SIZE);
        toDelete.forEach(([key]) => requestCache.delete(key));
    }
    
    // 清理localStorage缓存
    cleanLocalStorageCache();
}

/**
 * 【数据缓存机制增强】获取缓存（多级缓存策略）
 */
function getCachedData(cacheKey) {
    cacheStats.totalRequests++;
    
    // 首先检查内存缓存
    const memoryCache = requestCache.get(cacheKey);
    if (memoryCache && Date.now() - memoryCache.timestamp < CACHE_TTL) {
        // 更新访问时间（LRU）
        memoryCache.lastAccessed = Date.now();
        cacheStats.memoryHits++;
        return memoryCache;
    }
    
    // 内存缓存未命中，检查localStorage
    const localStorageCache = getCacheFromLocalStorage(cacheKey);
    if (localStorageCache) {
        // 将localStorage缓存提升到内存缓存
        requestCache.set(cacheKey, {
            ...localStorageCache,
            lastAccessed: Date.now()
        });
        cacheStats.localStorageHits++;
        return localStorageCache;
    }
    
    // 两级缓存都未命中
    cacheStats.misses++;
    return null;
}

/**
 * 【数据缓存机制增强】设置缓存（多级缓存策略）
 */
function setCachedData(cacheKey, data, totalCount) {
    const now = Date.now();
    
    // 保存到内存缓存
    requestCache.set(cacheKey, {
        data,
        totalCount,
        timestamp: now,
        lastAccessed: now
    });
    
    // 异步保存到localStorage（不阻塞主线程）
    setTimeout(() => {
        saveCacheToLocalStorage(cacheKey, data, totalCount);
    }, 0);
    
    // 清理过期缓存
    cleanExpiredCache();
}

/**
 * 【数据缓存机制增强】获取缓存统计信息
 */
function getCacheStats() {
    return {
        ...cacheStats,
        hitRate: cacheStats.totalRequests > 0 
            ? ((cacheStats.memoryHits + cacheStats.localStorageHits) / cacheStats.totalRequests * 100).toFixed(2) + '%'
            : '0%',
        memoryCacheSize: requestCache.size,
        localStorageCacheSize: Object.keys(localStorage).filter(key => key.startsWith(LOCALSTORAGE_CACHE_PREFIX)).length
    };
}

/**
 * 【数据缓存机制增强】缓存预热机制
 * 提前加载常用查询条件的数据
 */
async function warmupCache() {
    try {
        const commonQueries = [
            { page: 1, pageSize: 20, filters: { status: 'all', type: 'all', search: '' }, sorting: { col: 'entry_date', asc: false } },
            { page: 1, pageSize: 20, filters: { status: '待处理', type: 'all', search: '' }, sorting: { col: 'entry_date', asc: false } }
        ];
        
        for (const query of commonQueries) {
            const cacheKey = getCacheKey(query.page, query.pageSize, query.filters, query.sorting);
            const cached = getCachedData(cacheKey);
            if (!cached) {
                // 异步预加载，不阻塞主线程
                setTimeout(async () => {
                    try {
                        const originalFilters = { ...ListState.filters };
                        const originalSorting = { ...ListState.sorting };
                        const originalPage = ListState.pagination.page;
                        
                        ListState.filters = query.filters;
                        ListState.sorting = query.sorting;
                        ListState.pagination.page = query.page;
                        
                        await fetchTableData(false, false, query.page);
                        
                        // 恢复原始状态
                        ListState.filters = originalFilters;
                        ListState.sorting = originalSorting;
                        ListState.pagination.page = originalPage;
                    } catch (error) {
                        // 缓存预热失败，静默处理
                    }
                }, 100);
            }
        }
    } catch (error) {
        // 缓存预热异常，静默处理
    }
}

// 【修复】清除所有缓存（用于强制刷新数据）
function clearAllCache() {
    requestCache.clear();
    
    // 清理localStorage缓存
    try {
        const keys = Object.keys(localStorage);
        keys.forEach(key => {
            if (key.startsWith(LOCALSTORAGE_CACHE_PREFIX)) {
                localStorage.removeItem(key);
            }
        });
    } catch (error) {
        // 清理localStorage缓存失败，静默处理
    }
    
    // 重置统计信息
    cacheStats.memoryHits = 0;
    cacheStats.localStorageHits = 0;
    cacheStats.misses = 0;
    cacheStats.totalRequests = 0;
}

// 初始化全局用户数组
if (typeof window !== 'undefined' && !window.users) {
    window.users = [];
}

/**
 * 设置数据库连接状态
 */
function setDbConnectionState(state) {
    dbConnectionState = state;
    updateDbStatusIndicator();
}

/**
 * 更新数据库状态指示灯
 */
function updateDbStatusIndicator() {
    const indicator = document.getElementById('dbStatusIndicator');
    if (!indicator) return;
    
    indicator.classList.remove('bg-green-500', 'bg-yellow-500', 'bg-red-500', 'animate-ping');
    
    switch (dbConnectionState) {
        case 'connected':
            indicator.classList.add('bg-green-500', 'animate-ping');
            break;
        case 'connecting':
            indicator.classList.add('bg-yellow-500', 'animate-ping');
            break;
        case 'error':
            indicator.classList.add('bg-red-500');
            break;
        default:
            indicator.classList.add('bg-red-500');
            break;
    }
}

/**
 * 设置刷新按钮状态
 */
function setRefreshButtonState(isRefreshing) {
    const refreshBtn = document.getElementById('refreshBtn');
    const refreshIcon = document.getElementById('refreshIcon');
    
    if (!refreshBtn || !refreshIcon) return;
    
    if (isRefreshing) {
        refreshIcon.classList.add('animate-spin');
        refreshBtn.disabled = true;
        refreshBtn.classList.add('opacity-70', 'cursor-not-allowed');
    } else {
        refreshIcon.classList.remove('animate-spin');
        refreshBtn.disabled = false;
        refreshBtn.classList.remove('opacity-70', 'cursor-not-allowed');
    }
}

/**
 * 刷新数据库数据
 */
async function refreshDatabase() {
    try {
        setDbConnectionState('connecting');
        setRefreshButtonState(true);
        
        await loadDataFromSupabase();
        renderDatabase();
        
        setDbConnectionState('connected');
        showToast('数据已成功刷新', 'success');
    } catch (error) {
        setDbConnectionState('error');
        showToast('数据刷新失败，请检查网络连接后重试', 'error');
    } finally {
        setRefreshButtonState(false);
    }
}

/**
 * 从Supabase加载数据（兼容旧版，仅用于本地缓存）
 */
async function loadDataFromSupabase() {
    try {
        const { data, error } = await supabaseClient
            .from('claims_v2')
            .select('*')
            .order('entry_date', { ascending: false });
        
        if (error) {
            return JSON.parse(localStorage.getItem('wh_claims_db_pro')) || [];
        } else {
            localStorage.setItem('wh_claims_db_pro', JSON.stringify(data || []));
            return data || [];
        }
    } catch (error) {
        return JSON.parse(localStorage.getItem('wh_claims_db_pro')) || [];
    }
}

/**
 * 服务端分页数据获取函数（性能优化版）
 * 从Supabase获取表格数据（支持分页、筛选、排序、字段筛选）
 * @param {boolean} append - 是否为追加模式
 * @param {boolean} forceRefresh - 是否强制刷新（跳过缓存）
 */
/**
 * 获取分页数据
 * @param {boolean} append - 是否追加数据（用于加载更多）
 * @param {boolean} forceRefresh - 是否强制刷新（忽略缓存）
 * @param {number} page - 自定义页码（可选，不传则使用 ListState.pagination.page）
 * @param {boolean} keepScrollPosition - 是否保持滚动位置
 */
/**
 * 获取表格数据 - 修复版
 * 逻辑：完全依赖后端查询，移除前端冗余过滤
 */
async function fetchTableData(append = false, forceRefresh = false, page = null, keepScrollPosition = false) {
    if (!supabaseClient) return;

    // 1. 设置页码
    if (page !== null && page > 0) ListState.pagination.page = page;
    const targetPage = page !== null ? page : ListState.pagination.page;
    
    // 保存当前滚动位置（如果需要保持）
    let savedScrollTop = 0;
    if (keepScrollPosition && window.virtualScrollManager) {
        savedScrollTop = window.virtualScrollManager.container.scrollTop;
    }
    
    // 【性能优化】检查缓存（只在非追加模式和未强制刷新时使用缓存）
    // 因为 switchSubTab 传了 forceRefresh=true，会自动跳过缓存
    if (!append && !forceRefresh) {
        cleanExpiredCache();
        const cacheKey = getCacheKey(
            targetPage,
            ListState.pagination.pageSize,
            ListState.filters,
            ListState.sorting
        );
        const cached = getCachedData(cacheKey);
        if (cached) {
            // 【数据缓存机制增强】使用缓存数据（多级缓存）
            ListState.data = cached.data;
            ListState.totalCount = cached.totalCount;
            setDbConnectionState('connected');
            
            // 恢复滚动位置
            if (keepScrollPosition && savedScrollTop > 0 && window.virtualScrollManager) {
                requestAnimationFrame(() => {
                    window.virtualScrollManager.container.scrollTop = savedScrollTop;
                });
            }
            
            renderDatabase();
            renderPaginationControls();
            return;
        }
    }

    // 2. 取消旧请求，防止竞态条件
    if (currentFetchController) currentFetchController.abort();
    currentFetchController = new AbortController();
    const requestId = ++fetchRequestId;

    // 【骨架屏】记录加载开始时间，用于快速加载检测
    const loadingStartTime = Date.now();
    let skeletonTimeout = null;
    
    try {
        ListState.isLoading = true;
        // 【骨架屏】非追加模式时显示骨架屏（替代原有的全屏遮罩）
        // 【优化】添加延迟显示，避免快速加载时的闪烁（> 100ms 才显示）
        if (!append) {
            skeletonTimeout = setTimeout(() => {
                // 检查是否仍在加载中
                if (ListState.isLoading && requestId === fetchRequestId) {
                    if (typeof showSkeletonTable === 'function') {
                        showSkeletonTable();
                    } else if (typeof showLoading === 'function') {
                        // 降级方案：如果骨架屏函数不存在，使用原有的加载方式
                        showLoading();
                    }
                }
            }, 100);
        }

        const start = (targetPage - 1) * ListState.pagination.pageSize;
        const end = start + ListState.pagination.pageSize - 1;

        // 3. 构建 Supabase 查询
        let query = supabaseClient
            .from('claims_v2')
            .select('*', { count: 'exact' });
        
        // 应用排序：entry_date 现在是 timestamp 类型，支持精确排序，不需要复合排序
        query = query.order(ListState.sorting.col, { ascending: ListState.sorting.asc });

        // 4. 【核心修复】应用状态筛选
        // 只要状态不是 'all'，就严格让数据库只返回该状态的数据
        if (ListState.filters.status && ListState.filters.status !== 'all') {
            // 去除空格，确保精准匹配
            const statusValue = String(ListState.filters.status).trim();
            query = query.eq('process_status', statusValue);
        }

        // 应用高级筛选条件
        if (ListState.filters.advancedFilters) {
            query = applyAdvancedFilters(query, ListState.filters.advancedFilters);
        }
        
        // 应用搜索条件
        if (ListState.filters.search && ListState.filters.search.trim()) {
            query = applySearchConditions(query, ListState.filters);
        }

        // 5. 应用分页
        query = query.range(start, end);

        // 6. 发送请求
        const { data, count, error } = await query;

        if (requestId !== fetchRequestId) return; // 请求已过期
        if (error) throw error;

        // 7. 【核心修复】直接使用数据，不要再做任何前端 filter
        const newData = data || [];
        
        // 如果是追加模式（滚动加载），拼接数据；否则直接替换
        ListState.data = append ? [...ListState.data, ...newData] : newData;
        ListState.totalCount = count || 0;

        setDbConnectionState('connected');

        // 【骨架屏】如果数据加载很快（< 100ms），清除延迟显示的定时器
        if (skeletonTimeout) {
            clearTimeout(skeletonTimeout);
            skeletonTimeout = null;
        }
        
        // 8. 渲染视图
        // 传递 forceRefresh 给 renderDatabase，告诉它这是一次强制刷新，需要重置虚拟滚动位置
        // 【骨架屏】renderDatabase 会自动清除骨架屏
        if (typeof renderDatabase === 'function') {
            renderDatabase(forceRefresh); 
        }
        
        if (typeof renderPaginationControls === 'function') renderPaginationControls();
        if (typeof updateStatusCounts === 'function') updateStatusCounts();
        
    } catch (error) {
        // 【骨架屏】错误时清除延迟显示的定时器
        if (skeletonTimeout) {
            clearTimeout(skeletonTimeout);
            skeletonTimeout = null;
        }
        console.error("数据加载失败:", error);
        if (error.name !== 'AbortError') {
            if (typeof showToast === 'function') {
                showToast("数据加载失败", "error");
            }
        }
        
        // 【数据缓存机制增强】客户端缓存降级策略：网络不可用时自动使用本地缓存
        if (requestId === fetchRequestId) {
            const cacheKey = getCacheKey(
                targetPage,
                ListState.pagination.pageSize,
                ListState.filters,
                ListState.sorting
            );
            
            // 首先尝试从缓存获取数据
            const cached = getCachedData(cacheKey);
            if (cached) {
                ListState.data = cached.data;
                ListState.totalCount = cached.totalCount;
                setDbConnectionState('connected');
            } else {
                // 缓存未命中，降级到localStorage中的旧数据
                try {
                    const localData = JSON.parse(localStorage.getItem('wh_claims_db_pro')) || [];
                    const start = (ListState.pagination.page - 1) * ListState.pagination.pageSize;
                    const end = start + ListState.pagination.pageSize - 1;
                    const localPageData = localData.slice(start, end + 1);
                    
                    ListState.data = append ? [...ListState.data, ...localPageData] : localPageData;
                    ListState.totalCount = localData.length;
                    setDbConnectionState('error');
                } catch (localStorageError) {
                    ListState.data = append ? ListState.data : [];
                    ListState.totalCount = 0;
                    setDbConnectionState('error');
                }
            }
            
            // 【修复】错误处理时立即渲染，确保用户能看到错误状态
            // 【骨架屏】错误时清除骨架屏
            if (typeof hideSkeletonTable === 'function') {
                hideSkeletonTable();
            }
            if (typeof renderDatabase === 'function') {
                renderDatabase();
            }
            if (typeof renderPaginationControls === 'function') {
                renderPaginationControls();
            }
        }
    } finally {
        if (requestId === fetchRequestId) {
            ListState.isLoading = false;
            currentFetchController = null;
            if(typeof hideLoading === 'function') hideLoading();
        }
    }
}

// 【性能优化】获取可见列所需的字段列表
function getRequiredFieldsForVisibleColumns() {
    // 基础必需字段（ID、状态等）
    const baseFields = ['id', 'process_status', 'entry_date'];
    
    // 从可见列获取字段（通过window对象访问，因为visibleColumns在ui.js中定义）
    const visibleFields = (typeof window !== 'undefined' && window.visibleColumns) ? 
        window.visibleColumns : 
        (typeof visibleColumns !== 'undefined' ? visibleColumns : []);
    
    // 合并并去重
    const allFields = [...new Set([...baseFields, ...visibleFields])];
    
    // 【性能优化】为了简化，当前版本仍返回*，但保留此函数以备后续优化
    // 如果需要启用字段筛选，可以取消下面的注释，并注释掉 return '*'
    // return allFields.join(',');
    return '*'; // 暂时返回所有字段，避免字段缺失导致的错误
}

// ============================================
// 【搜索功能增强】搜索逻辑实现
// ============================================

/**
 * 应用搜索条件到查询对象
 * @param {Object} query - Supabase 查询对象
 * @param {Object} filters - 筛选条件对象
 * @returns {Object} 修改后的查询对象
 */
function applySearchConditions(query, filters) {
    const searchTerm = filters.search.trim();
    const searchMode = filters.searchMode || 'fuzzy';
    const searchField = filters.searchField || 'all';
    
    // 【清理】旧的高级搜索（advancedSearch）已删除，现在使用快速筛选系统（advancedFilters）
    
    // 简单搜索模式
    // 确定要搜索的字段
    let fieldsToSearch = [];
    
    // 【优化】限制搜索字段为：海外仓单号(order_no)、物流运单号(tracking_no)、订单SKU(sku)
    if (searchField === 'order_tracking_sku') {
        // 只搜索这三个指定字段
        fieldsToSearch = ['order_no', 'tracking_no', 'sku'];
    } else if (searchField === 'all') {
        // 搜索所有可搜索字段（保留兼容性）
        const fieldMap = (typeof window !== 'undefined' && window.SEARCH_FIELD_MAP) ? 
            window.SEARCH_FIELD_MAP : 
            (typeof SEARCH_FIELD_MAP !== 'undefined' ? SEARCH_FIELD_MAP : {});
        // 【修复】排除日期类型字段，因为日期字段不支持文本搜索
        fieldsToSearch = Object.keys(fieldMap).filter(key => {
            const config = fieldMap[key];
            return config.searchable && config.type !== 'date';
        });
    } else {
        // 搜索指定字段（检查是否为日期类型）
        const fieldMap = (typeof window !== 'undefined' && window.SEARCH_FIELD_MAP) ? 
            window.SEARCH_FIELD_MAP : 
            (typeof SEARCH_FIELD_MAP !== 'undefined' ? SEARCH_FIELD_MAP : {});
        const fieldConfig = fieldMap[searchField];
        // 只有非日期类型字段才允许文本搜索
        if (fieldConfig && fieldConfig.type !== 'date') {
            fieldsToSearch = [searchField];
        }
    }
    
    if (fieldsToSearch.length === 0) {
        return query; // 没有可搜索字段，返回原查询
    }
    
    // 构建搜索条件
    if (searchMode === 'exact') {
        // 精确搜索：使用等号匹配
        // 对于文本字段使用 =，对于数字字段也使用 =
        const exactConditions = fieldsToSearch.map(field => {
            const fieldConfig = (typeof window !== 'undefined' && window.SEARCH_FIELD_MAP) ? 
                window.SEARCH_FIELD_MAP[field] : null;
            
            if (fieldConfig && fieldConfig.type === 'number') {
                // 数字字段：尝试转换为数字进行精确匹配
                const numValue = parseFloat(searchTerm);
                if (!isNaN(numValue)) {
                    return `${field}.eq.${numValue}`;
                }
                return null; // 无效数字，跳过
            } else {
                // 文本字段：精确匹配（不区分大小写）
                // 使用textSearch或eq，根据Supabase支持情况
                return `${field}.eq.${searchTerm}`;
            }
        }).filter(condition => condition !== null);
        
        if (exactConditions.length > 0) {
            query = query.or(exactConditions.join(','));
        }
    } else {
        // 模糊搜索：使用 ILIKE（不区分大小写的模糊匹配）
        // 【修复】只对文本字段使用ILIKE，数字字段需要特殊处理
        const searchPattern = `%${searchTerm.toLowerCase()}%`;
        const fuzzyConditions = fieldsToSearch.map(field => {
            const fieldConfig = (typeof window !== 'undefined' && window.SEARCH_FIELD_MAP) ? 
                window.SEARCH_FIELD_MAP[field] : null;
            
            // 确保不是日期类型（双重检查）
            if (fieldConfig && fieldConfig.type === 'date') {
                return null; // 跳过日期字段
            }
            
            // 【修复】数字字段不能使用ILIKE，需要转换为数字进行匹配
            if (fieldConfig && fieldConfig.type === 'number') {
                // 尝试将搜索词转换为数字
                const numValue = parseFloat(searchTerm);
                if (!isNaN(numValue)) {
                    // 如果转换成功，使用等号精确匹配（数字字段不支持模糊匹配）
                    return `${field}.eq.${numValue}`;
                }
                // 如果转换失败，跳过这个字段（数字字段不支持文本模糊匹配）
                return null;
            }
            
            // 只对文本字段使用ILIKE
            return `${field}.ilike.${searchPattern}`;
        }).filter(condition => condition !== null);
        
        if (fuzzyConditions.length > 0) {
            query = query.or(fuzzyConditions.join(','));
        }
    }
    
    return query;
}

/**
 * 【高级搜索重构】应用高级筛选条件
 * @param {Object} query - Supabase 查询对象
 * @param {Object} filters - 高级筛选条件对象
 * @returns {Object} 修改后的查询对象
 */
function applyAdvancedFilters(query, filters) {
    if (!filters) return query;
    
    // 【修复】海外仓单号 - 模糊匹配
    if (filters.order_no) {
        query = query.ilike('order_no', `%${filters.order_no}%`);
    }
    
    // 【修复】物流运单号 - 模糊匹配
    if (filters.tracking_no) {
        query = query.ilike('tracking_no', `%${filters.tracking_no}%`);
    }
    
    // 【修复】发货仓 - 精确匹配（对应明细列表中的warehouse字段）
    if (filters.warehouse) {
        // 【修复】确保值完全匹配，去除首尾空格
        const warehouseValue = filters.warehouse.trim();
        query = query.eq('warehouse', warehouseValue);
    }
    
    // 【修复】订单SKU - 模糊匹配
    if (filters.sku) {
        query = query.ilike('sku', `%${filters.sku}%`);
    }
    
    // 【修复】发货日期范围（对应明细列表中的ship_date字段）
    if (filters.ship_date_start) {
        // 确保日期格式正确（YYYY-MM-DD）
        const startDate = filters.ship_date_start.trim();
        query = query.gte('ship_date', startDate);
    }
    if (filters.ship_date_end) {
        // 确保日期格式正确（YYYY-MM-DD）
        const endDate = filters.ship_date_end.trim();
        query = query.lte('ship_date', endDate);
    }
    
    // 【修复】申请提交日期范围（对应明细列表中的entry_date字段）
    // entry_date 现在是 timestamp 类型，需要转换为日期范围
    if (filters.entry_date_start) {
        // 确保日期格式正确（YYYY-MM-DD），转换为当天的开始时间（00:00:00）
        const startDate = filters.entry_date_start.trim();
        query = query.gte('entry_date', startDate + 'T00:00:00');
    }
    if (filters.entry_date_end) {
        // 确保日期格式正确（YYYY-MM-DD），转换为当天的结束时间（23:59:59）
        const endDate = filters.entry_date_end.trim();
        query = query.lte('entry_date', endDate + 'T23:59:59');
    }
    
    // 【修复】索赔类型 - 精确匹配（对应明细列表中的claim_type字段）
    if (filters.claim_type) {
        // 【修复】确保值完全匹配，去除首尾空格
        const claimTypeValue = filters.claim_type.trim();
        query = query.eq('claim_type', claimTypeValue);
    }
    
    return query;
}

/**
 * 【清理】旧的高级搜索函数（applyAdvancedSearch）已删除
 * 旧的高级搜索面板（advancedSearchPanel）已删除，现在使用快速筛选系统（advancedFilters）
 * 快速筛选通过 applyAdvancedFilters() 函数处理
 */

// 将函数暴露到全局，供 HTML 中的 onclick 等直接调用
if (typeof window !== 'undefined') {
    window.fetchTableData = fetchTableData;
    window.clearAllCache = clearAllCache;
    window.getCacheStats = getCacheStats;
    window.warmupCache = warmupCache;
    window.applyAdvancedFilters = applyAdvancedFilters;
    window.applySearchConditions = applySearchConditions;
}

/**
 * 保存数据到Supabase
 */
async function saveDataToSupabase() {
    try {
        const latestRecord = database[0];
        if (!latestRecord) return;
        
        const dataToSave = sanitizeDataForSupabase(latestRecord);
        
        if (!dataToSave.id) {
            return;
        }

        const { data, error } = await supabaseClient
            .from('claims_v2')
            .insert([dataToSave])
            .select();
        
        if (error) {
            showToast('云端保存失败: ' + error.message, 'error');
            localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
        } else {
            showToast('数据已同步至云端', 'success');
        }
    } catch (error) {
        localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
    }
}

/**
 * 更新数据到Supabase
 */
async function updateDataInSupabase(id, data) {
    try {
        const dataToUpdate = sanitizeDataForSupabase(data);
        delete dataToUpdate.id;
        
        const { error } = await supabaseClient
            .from('claims_v2')
            .update(dataToUpdate)
            .eq('id', id);
        
        if (error) {
            handleError(error, '云端更新');
            const index = database.findIndex(item => item.id === id);
            if (index !== -1) {
                database[index] = data;
                localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
            }
            return false;
        } else {
            showToast('云端数据已更新', 'success');
            return true;
        }
    } catch (error) {
        const index = database.findIndex(item => item.id === id);
        if (index !== -1) {
            database[index] = data;
            localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
        }
        return false;
    }
}

/**
 * 删除数据从Supabase
 */
async function deleteDataFromSupabase(id) {
    try {
        const { error } = await supabaseClient
            .from('claims_v2')
            .delete()
            .eq('id', id);
        
        if (error) {
            handleError(error, '删除数据');
            database = database.filter(item => item.id !== id);
            localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
        } else {
            database = database.filter(item => item.id !== id);
            localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
        }
    } catch (error) {
        database = database.filter(item => item.id !== id);
        localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
    }
}

/**
 * 检查Supabase表结构
 */
async function checkSupabaseTableStructure() {
    if (!supabaseClient) return;
    try {
        const { data: tableInfo, error: tableError } = await supabaseClient
            .from('claims_v2')
            .select('*')
            .limit(1);
        
        if (tableError) {
            // 获取表信息失败，静默处理
        }
    } catch (error) {
        // 检查表结构异常，静默处理
    }
}

/**
 * 从Supabase加载所有用户数据（从users_v2表）
 * 此函数用于"用户管理"模块
 */
async function loadUsersFromSupabase() {
    // 【骨架屏】显示用户列表骨架屏（替代原有的全屏遮罩）
    let skeletonTimeout = null;
    const loadingStartTime = Date.now();
    
    // 延迟显示骨架屏，避免快速加载时的闪烁（> 100ms 才显示）
    skeletonTimeout = setTimeout(() => {
        if (Date.now() - loadingStartTime >= 100) {
            if (typeof showSkeletonTableUsers === 'function') {
                showSkeletonTableUsers(5); // 默认显示5行
            } else if (typeof showLoading === 'function') {
                // 降级方案：如果骨架屏函数不存在，使用原有的加载方式
                showLoading('正在加载用户数据...');
            }
        }
    }, 100);
    
    try {
        if (!supabaseClient) {
            // 【骨架屏】清除延迟显示的定时器
            if (skeletonTimeout) {
                clearTimeout(skeletonTimeout);
                skeletonTimeout = null;
            }
            if (typeof hideSkeletonTableUsers === 'function') {
                hideSkeletonTableUsers();
            } else if (typeof hideLoading === 'function') {
                hideLoading();
            }
            if (typeof showToast === 'function') {
                showToast('无法连接到数据库，请稍后重试', 'error');
            }
            return false;
        }
        
        // 尝试从Supabase查询users_v2表
        const { data, error } = await supabaseClient
            .from('users_v2')
            .select('*')
            .order('created_at', { ascending: false });
        
        if (error) {
            // 【骨架屏】清除延迟显示的定时器并隐藏骨架屏
            if (skeletonTimeout) {
                clearTimeout(skeletonTimeout);
                skeletonTimeout = null;
            }
            if (typeof hideSkeletonTableUsers === 'function') {
                hideSkeletonTableUsers();
            } else if (typeof hideLoading === 'function') {
                hideLoading();
            }
            
            // 针对42P17错误（无限递归策略）进行特殊处理
            if (error.code === '42P17') {
                // 使用空数组作为备选，显示"暂无用户数据"
                window.users = [];
                return true;
            } else {
                // 其他数据库错误
                if (typeof showToast === 'function') {
                    showToast('无法连接到数据库，请稍后重试', 'error');
                }
                return false;
            }
        }
        
        // 转换用户数据格式
        const formattedUsers = (data || []).map(user => {
            // 处理 permissions 字段（可能是 JSON 字符串或对象）
            let permissions = {};
            if (user.permissions) {
                if (typeof user.permissions === 'string') {
                    try {
                        permissions = JSON.parse(user.permissions);
                    } catch (e) {
                        permissions = {};
                    }
                } else if (typeof user.permissions === 'object') {
                    permissions = user.permissions;
                }
            }
            
            return {
                id: user.id,
                username: user.username || '未设置',
                email: user.email,
                role: user.role || 'user',
                status: user.status === 'active' ? 'active' : 'disabled',
                permissions: permissions,
                created_at: user.created_at
            };
        });
        
        // 更新全局用户数组
        window.users = formattedUsers;
        
        // 【骨架屏】如果数据加载很快（< 100ms），清除延迟显示的定时器
        if (skeletonTimeout) {
            clearTimeout(skeletonTimeout);
            skeletonTimeout = null;
        }
        
        // 【骨架屏】隐藏骨架屏（renderUserManagement会处理，这里确保清除）
        if (typeof hideSkeletonTableUsers === 'function') {
            hideSkeletonTableUsers();
        } else if (typeof hideLoading === 'function') {
            hideLoading();
        }
        
        return true;
    } catch (error) {
        // 【骨架屏】错误时清除延迟显示的定时器并隐藏骨架屏
        if (skeletonTimeout) {
            clearTimeout(skeletonTimeout);
            skeletonTimeout = null;
        }
        if (typeof hideSkeletonTableUsers === 'function') {
            hideSkeletonTableUsers();
        } else if (typeof hideLoading === 'function') {
            hideLoading();
        }
        if (typeof showToast === 'function') {
            showToast('加载用户数据失败：' + (error.message || '未知错误'), 'error');
        }
        return false;
    }
}

// 将函数暴露到全局作用域，供HTML中的onclick等调用
window.loadUsersFromSupabase = loadUsersFromSupabase;

