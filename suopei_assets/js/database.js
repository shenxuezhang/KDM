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

const requestCache = new Map();
const CACHE_TTL = 30000;
const MAX_CACHE_SIZE = 50;
const LOCALSTORAGE_CACHE_PREFIX = 'wh_claims_cache_';
const LOCALSTORAGE_CACHE_TTL = 300000;
const MAX_LOCALSTORAGE_CACHE_SIZE = 20;

const cacheStats = {
    memoryHits: 0,
    localStorageHits: 0,
    misses: 0,
    totalRequests: 0
};

/**
 * 生成缓存键
 * @param {number} page - 页码
 * @param {number} pageSize - 每页大小
 * @param {Object} filters - 筛选条件
 * @param {Object} sorting - 排序条件
 * @returns {string} 缓存键
 */
function getCacheKey(page, pageSize, filters, sorting) {
    return JSON.stringify({
        page,
        pageSize,
        status: filters.status,
        type: filters.type,
        search: filters.search,
        searchMode: filters.searchMode,
        searchField: filters.searchField,
        advancedFilters: filters.advancedFilters,
        col: sorting.col,
        asc: sorting.asc
    });
}

/**
 * 从localStorage获取缓存
 * @param {string} cacheKey - 缓存键
 * @returns {Object|null} 缓存数据或null
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
 * 保存缓存到localStorage
 * @param {string} cacheKey - 缓存键
 * @param {Array} data - 数据
 * @param {number} totalCount - 总记录数
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
        if (error.name === 'QuotaExceededError') {
            cleanLocalStorageCache(true);
            try {
                localStorage.setItem(LOCALSTORAGE_CACHE_PREFIX + cacheKey, JSON.stringify({
                    data,
                    totalCount,
                    timestamp: Date.now()
                }));
            } catch (retryError) {
                // 静默处理
            }
        }
    }
}

/**
 * 清理localStorage缓存
 * @param {boolean} forceClean - 是否强制清理
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
                    localStorage.removeItem(key);
                }
            });
        
        if (cacheEntries.length > MAX_LOCALSTORAGE_CACHE_SIZE || forceClean) {
            cacheEntries.sort((a, b) => a.timestamp - b.timestamp);
            const toDelete = cacheEntries.slice(0, Math.max(0, cacheEntries.length - MAX_LOCALSTORAGE_CACHE_SIZE + (forceClean ? 5 : 0)));
            toDelete.forEach(({ key }) => localStorage.removeItem(key));
        }
    } catch (error) {
        // 静默处理
    }
}

/**
 * LRU缓存清理策略：优先清理最久未访问的缓存条目
 */
function cleanExpiredCache() {
    const now = Date.now();
    
    for (const [key, value] of requestCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            requestCache.delete(key);
        }
    }
    
    if (requestCache.size > MAX_CACHE_SIZE) {
        const sortedEntries = Array.from(requestCache.entries())
            .sort((a, b) => (a[1].lastAccessed || a[1].timestamp) - (b[1].lastAccessed || b[1].timestamp));
        const toDelete = sortedEntries.slice(0, requestCache.size - MAX_CACHE_SIZE);
        toDelete.forEach(([key]) => requestCache.delete(key));
    }
    
    cleanLocalStorageCache();
}

/**
 * 获取缓存（多级缓存策略）
 * @param {string} cacheKey - 缓存键
 * @returns {Object|null} 缓存数据或null
 */
function getCachedData(cacheKey) {
    cacheStats.totalRequests++;
    
    const memoryCache = requestCache.get(cacheKey);
    if (memoryCache && Date.now() - memoryCache.timestamp < CACHE_TTL) {
        memoryCache.lastAccessed = Date.now();
        cacheStats.memoryHits++;
        return memoryCache;
    }
    
    const localStorageCache = getCacheFromLocalStorage(cacheKey);
    if (localStorageCache) {
        requestCache.set(cacheKey, {
            ...localStorageCache,
            lastAccessed: Date.now()
        });
        cacheStats.localStorageHits++;
        return localStorageCache;
    }
    
    cacheStats.misses++;
    return null;
}

/**
 * 设置缓存（多级缓存策略）
 * @param {string} cacheKey - 缓存键
 * @param {Array} data - 数据
 * @param {number} totalCount - 总记录数
 */
function setCachedData(cacheKey, data, totalCount) {
    const now = Date.now();
    
    requestCache.set(cacheKey, {
        data,
        totalCount,
        timestamp: now,
        lastAccessed: now
    });
    
    setTimeout(() => {
        saveCacheToLocalStorage(cacheKey, data, totalCount);
    }, 0);
    
    cleanExpiredCache();
}

/**
 * 获取缓存统计信息
 * @returns {Object} 缓存统计信息
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
 * 缓存预热机制：提前加载常用查询条件的数据
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
                        // 静默处理
                    }
                }, 100);
            }
        }
    } catch (error) {
        // 静默处理
    }
}

/**
 * 清除与指定筛选条件相关的所有缓存（忽略排序）
 * 用于排序状态变化时，清除可能包含错误排序的缓存
 * @param {Object} filters - 筛选条件
 */
function clearCacheByFilters(filters) {
    try {
        const filterKey = JSON.stringify({
            status: filters.status,
            type: filters.type,
            search: filters.search,
            searchMode: filters.searchMode,
            searchField: filters.searchField,
            advancedFilters: filters.advancedFilters
        });
        
        // 清除内存缓存中匹配的条目
        const keysToDelete = [];
        for (const [key, value] of requestCache.entries()) {
            try {
                const cachedKey = JSON.parse(key);
                const cachedFilterKey = JSON.stringify({
                    status: cachedKey.status,
                    type: cachedKey.type,
                    search: cachedKey.search,
                    searchMode: cachedKey.searchMode,
                    searchField: cachedKey.searchField,
                    advancedFilters: cachedKey.advancedFilters
                });
                
                if (cachedFilterKey === filterKey) {
                    keysToDelete.push(key);
                }
            } catch (error) {
                // 解析失败，跳过
            }
        }
        keysToDelete.forEach(key => requestCache.delete(key));
        
        // 清除localStorage中匹配的条目
        const localStorageKeys = Object.keys(localStorage);
        localStorageKeys.forEach(key => {
            if (key.startsWith(LOCALSTORAGE_CACHE_PREFIX)) {
                try {
                    const cacheKey = key.replace(LOCALSTORAGE_CACHE_PREFIX, '');
                    const cachedKey = JSON.parse(cacheKey);
                    const cachedFilterKey = JSON.stringify({
                        status: cachedKey.status,
                        type: cachedKey.type,
                        search: cachedKey.search,
                        searchMode: cachedKey.searchMode,
                        searchField: cachedKey.searchField,
                        advancedFilters: cachedKey.advancedFilters
                    });
                    
                    if (cachedFilterKey === filterKey) {
                        localStorage.removeItem(key);
                    }
                } catch (error) {
                    // 解析失败，跳过
                }
            }
        });
    } catch (error) {
        // 静默处理
    }
}

/**
 * 清除所有缓存（用于强制刷新数据）
 */
function clearAllCache() {
    requestCache.clear();
    
    try {
        const keys = Object.keys(localStorage);
        keys.forEach(key => {
            if (key.startsWith(LOCALSTORAGE_CACHE_PREFIX)) {
                localStorage.removeItem(key);
            }
        });
    } catch (error) {
        // 静默处理
    }
    
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
 * 获取表格数据
 * @param {boolean} append - 是否追加数据（用于加载更多）
 * @param {boolean} forceRefresh - 是否强制刷新（忽略缓存）
 * @param {number} page - 自定义页码（可选，不传则使用 ListState.pagination.page）
 * @param {boolean} keepScrollPosition - 是否保持滚动位置
 */
async function fetchTableData(append = false, forceRefresh = false, page = null, keepScrollPosition = false) {
    if (!supabaseClient) return;

    if (page !== null && page > 0) ListState.pagination.page = page;
    const targetPage = page !== null ? page : ListState.pagination.page;
    
    let savedScrollTop = 0;
    if (keepScrollPosition && window.virtualScrollManager) {
        savedScrollTop = window.virtualScrollManager.container.scrollTop;
    }
    
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
            ListState.data = cached.data;
            ListState.totalCount = cached.totalCount;
            setDbConnectionState('connected');
            
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

    if (currentFetchController) currentFetchController.abort();
    currentFetchController = new AbortController();
    const requestId = ++fetchRequestId;

    let skeletonTimeout = null;
    
    try {
        ListState.isLoading = true;
        if (!append) {
            skeletonTimeout = setTimeout(() => {
                if (ListState.isLoading && requestId === fetchRequestId) {
                    if (typeof showSkeletonTable === 'function') {
                        showSkeletonTable();
                    } else if (typeof showLoading === 'function') {
                        showLoading();
                    }
                }
            }, 100);
        }

        const start = (targetPage - 1) * ListState.pagination.pageSize;
        const end = start + ListState.pagination.pageSize - 1;

        let query = supabaseClient
            .from('claims_v2')
            .select('*', { count: 'exact' });
        
        query = query.order(ListState.sorting.col, { ascending: ListState.sorting.asc });

        if (ListState.filters.status && ListState.filters.status !== 'all') {
            const statusValue = String(ListState.filters.status).trim();
            query = query.eq('process_status', statusValue);
        }

        if (ListState.filters.advancedFilters) {
            query = applyAdvancedFilters(query, ListState.filters.advancedFilters);
        }
        
        if (ListState.filters.search && ListState.filters.search.trim()) {
            query = applySearchConditions(query, ListState.filters);
        }

        query = query.range(start, end);

        const { data, count, error } = await query;

        if (requestId !== fetchRequestId) return;
        if (error) throw error;

        const newData = data || [];
        ListState.data = append ? [...ListState.data, ...newData] : newData;
        ListState.totalCount = count || 0;

        setDbConnectionState('connected');

        if (skeletonTimeout) {
            clearTimeout(skeletonTimeout);
            skeletonTimeout = null;
        }
        
        if (typeof renderDatabase === 'function') {
            renderDatabase(forceRefresh); 
        }
        
        if (typeof renderPaginationControls === 'function') renderPaginationControls();
        
        // 优化：减少updateStatusCounts的调用频率，避免频繁更新
        // 只有在首次加载或强制刷新时才调用
        if ((typeof updateStatusCounts === 'function') && (forceRefresh || targetPage === 1)) {
            updateStatusCounts();
        }
        
    } catch (error) {
        if (skeletonTimeout) {
            clearTimeout(skeletonTimeout);
            skeletonTimeout = null;
        }
        if (error.name !== 'AbortError') {
            if (typeof showToast === 'function') {
                showToast("数据加载失败", "error");
            }
        }
        
        if (requestId === fetchRequestId) {
            const cacheKey = getCacheKey(
                targetPage,
                ListState.pagination.pageSize,
                ListState.filters,
                ListState.sorting
            );
            
            const cached = getCachedData(cacheKey);
            if (cached) {
                ListState.data = cached.data;
                ListState.totalCount = cached.totalCount;
                setDbConnectionState('connected');
            } else {
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

/**
 * 获取可见列所需的字段列表
 * @returns {string} 字段列表，当前返回 '*' 表示所有字段
 */
function getRequiredFieldsForVisibleColumns() {
    const baseFields = ['id', 'process_status', 'entry_date'];
    const visibleFields = (typeof window !== 'undefined' && window.visibleColumns) ? 
        window.visibleColumns : 
        (typeof visibleColumns !== 'undefined' ? visibleColumns : []);
    const allFields = [...new Set([...baseFields, ...visibleFields])];
    return '*';
}

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
    
    let fieldsToSearch = [];
    
    if (searchField === 'order_tracking_sku') {
        fieldsToSearch = ['order_no', 'tracking_no', 'sku'];
    } else if (searchField === 'all') {
        const fieldMap = (typeof window !== 'undefined' && window.SEARCH_FIELD_MAP) ? 
            window.SEARCH_FIELD_MAP : 
            (typeof SEARCH_FIELD_MAP !== 'undefined' ? SEARCH_FIELD_MAP : {});
        fieldsToSearch = Object.keys(fieldMap).filter(key => {
            const config = fieldMap[key];
            return config.searchable && config.type !== 'date';
        });
    } else {
        const fieldMap = (typeof window !== 'undefined' && window.SEARCH_FIELD_MAP) ? 
            window.SEARCH_FIELD_MAP : 
            (typeof SEARCH_FIELD_MAP !== 'undefined' ? SEARCH_FIELD_MAP : {});
        const fieldConfig = fieldMap[searchField];
        if (fieldConfig && fieldConfig.type !== 'date') {
            fieldsToSearch = [searchField];
        }
    }
    
    if (fieldsToSearch.length === 0) {
        return query;
    }
    
    if (searchMode === 'exact') {
        const exactConditions = fieldsToSearch.map(field => {
            const fieldConfig = (typeof window !== 'undefined' && window.SEARCH_FIELD_MAP) ? 
                window.SEARCH_FIELD_MAP[field] : null;
            
            if (fieldConfig && fieldConfig.type === 'number') {
                const numValue = parseFloat(searchTerm);
                if (!isNaN(numValue)) {
                    return `${field}.eq.${numValue}`;
                }
                return null;
            } else {
                return `${field}.eq.${searchTerm}`;
            }
        }).filter(condition => condition !== null);
        
        if (exactConditions.length > 0) {
            query = query.or(exactConditions.join(','));
        }
    } else {
        const searchPattern = `%${searchTerm.toLowerCase()}%`;
        const fuzzyConditions = fieldsToSearch.map(field => {
            const fieldConfig = (typeof window !== 'undefined' && window.SEARCH_FIELD_MAP) ? 
                window.SEARCH_FIELD_MAP[field] : null;
            
            if (fieldConfig && fieldConfig.type === 'date') {
                return null;
            }
            
            if (fieldConfig && fieldConfig.type === 'number') {
                const numValue = parseFloat(searchTerm);
                if (!isNaN(numValue)) {
                    return `${field}.eq.${numValue}`;
                }
                return null;
            }
            
            return `${field}.ilike.${searchPattern}`;
        }).filter(condition => condition !== null);
        
        if (fuzzyConditions.length > 0) {
            query = query.or(fuzzyConditions.join(','));
        }
    }
    
    return query;
}

/**
 * 应用高级筛选条件
 * @param {Object} query - Supabase 查询对象
 * @param {Object} filters - 高级筛选条件对象
 * @returns {Object} 修改后的查询对象
 */
function applyAdvancedFilters(query, filters) {
    if (!filters) return query;
    
    if (filters.order_no) {
        query = query.ilike('order_no', `%${filters.order_no}%`);
    }
    
    if (filters.tracking_no) {
        query = query.ilike('tracking_no', `%${filters.tracking_no}%`);
    }
    
    if (filters.store_by) {
        const storeByValue = filters.store_by.trim();
        query = query.eq('store_by', storeByValue);
    }
    
    if (filters.warehouse) {
        const warehouseValue = filters.warehouse.trim();
        query = query.eq('warehouse', warehouseValue);
    }
    
    if (filters.sku) {
        query = query.ilike('sku', `%${filters.sku}%`);
    }
    
    if (filters.ship_date_start) {
        const startDate = filters.ship_date_start.trim();
        query = query.gte('ship_date', startDate);
    }
    if (filters.ship_date_end) {
        const endDate = filters.ship_date_end.trim();
        query = query.lte('ship_date', endDate);
    }
    
    if (filters.entry_date_start) {
        const startDate = filters.entry_date_start.trim();
        query = query.gte('entry_date', startDate + 'T00:00:00');
    }
    if (filters.entry_date_end) {
        const endDate = filters.entry_date_end.trim();
        query = query.lte('entry_date', endDate + 'T23:59:59');
    }
    
    if (filters.claim_type) {
        const claimTypeValue = filters.claim_type.trim();
        query = query.eq('claim_type', claimTypeValue);
    }
    
    return query;
}

// 将函数暴露到全局，供 HTML 中的 onclick 等直接调用
if (typeof window !== 'undefined') {
    window.fetchTableData = fetchTableData;
    window.clearAllCache = clearAllCache;
    window.clearCacheByFilters = clearCacheByFilters;
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
 * 获取单条记录（用于冲突检测）
 */
async function getRecordById(id) {
    try {
        const { data, error } = await supabaseClient
            .from('claims_v2')
            .select('*')
            .eq('id', id)
            .single();
        
        if (error) {
            return null;
        }
        return data;
    } catch (error) {
        return null;
    }
}

/**
 * 更新数据到Supabase（带冲突检测）
 */
async function updateDataInSupabase(id, data, originalData = null) {
    try {
        // 【数据冲突处理】获取数据库中的最新记录
        const currentRecord = await getRecordById(id);
        
        if (!currentRecord) {
            showToast('记录不存在或已被删除', 'error');
            return false;
        }
        
        // 【数据冲突处理】检查关键字段是否被其他用户修改
        if (originalData) {
            const conflictFields = detectConflict(originalData, currentRecord, data);
            if (conflictFields.length > 0) {
                // 显示冲突解决对话框
                const resolved = await showConflictDialog(currentRecord, data, conflictFields);
                if (!resolved || !resolved.resolved) {
                    return false; // 用户取消操作
                }
                // 使用解决后的数据继续更新
                if (resolved.data) {
                    data = resolved.data;
                }
            }
        }
        
        const dataToUpdate = sanitizeDataForSupabase(data);
        delete dataToUpdate.id;
        
        // 【数据冲突处理】使用updated_at作为乐观锁（如果存在）
        let query = supabaseClient
            .from('claims_v2')
            .update(dataToUpdate)
            .eq('id', id);
        
        // 如果原始数据有updated_at，使用它作为版本检查
        if (originalData && originalData.updated_at && currentRecord.updated_at) {
            if (originalData.updated_at !== currentRecord.updated_at) {
                // 数据已被修改，但用户已选择解决冲突，继续更新
            }
        }
        
        const { error, data: updatedData } = await query.select().single();
        
        if (error) {
            // 检查是否是冲突错误（行数影响为0表示版本不匹配）
            if (error.code === 'PGRST116' || (error.message && error.message.includes('0 rows'))) {
                showToast('数据已被其他用户修改，请刷新后重试', 'error');
                // 刷新数据
                if (typeof fetchTableData === 'function') {
                    fetchTableData(false, true);
                }
                return false;
            }
            
            handleError(error, '云端更新');
            const index = database.findIndex(item => item.id === id);
            if (index !== -1) {
                database[index] = data;
                localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
            }
            return false;
        } else {
            // 更新本地缓存
            const index = database.findIndex(item => item.id === id);
            if (index !== -1 && updatedData) {
                database[index] = updatedData;
                localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
            }
            
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
 * 检测数据冲突
 * @param {Object} originalData - 编辑时的原始数据
 * @param {Object} currentRecord - 数据库中的当前数据
 * @param {Object} userData - 用户要保存的数据
 * @returns {Array} 冲突字段列表
 */
function detectConflict(originalData, currentRecord, userData) {
    const conflictFields = [];
    const keyFields = ['order_no', 'tracking_no', 'process_status', 'claim_total', 'claim_qty'];
    
    keyFields.forEach(field => {
        const originalValue = originalData[field];
        const currentValue = currentRecord[field];
        const userValue = userData[field];
        
        // 如果数据库中的值已被修改（与原始值不同），且用户也在修改这个字段
        if (originalValue !== currentValue && userValue !== currentValue) {
            conflictFields.push({
                field,
                originalValue,
                currentValue,
                userValue
            });
        }
    });
    
    return conflictFields;
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

