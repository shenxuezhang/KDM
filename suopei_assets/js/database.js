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

// 【性能优化】请求缓存（缓存最近的分页查询结果）
const requestCache = new Map();
const CACHE_TTL = 30000; // 缓存有效期：30秒
const MAX_CACHE_SIZE = 50; // 最大缓存条目数

// 【性能优化】生成缓存键
function getCacheKey(page, pageSize, filters, sorting) {
    return JSON.stringify({
        page,
        pageSize,
        status: filters.status,
        type: filters.type,
        search: filters.search,
        col: sorting.col,
        asc: sorting.asc
    });
}

// 【性能优化】清理过期缓存
function cleanExpiredCache() {
    const now = Date.now();
    for (const [key, value] of requestCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            requestCache.delete(key);
        }
    }
    
    // 如果缓存仍然过大，删除最旧的条目
    if (requestCache.size > MAX_CACHE_SIZE) {
        const sortedEntries = Array.from(requestCache.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toDelete = sortedEntries.slice(0, requestCache.size - MAX_CACHE_SIZE);
        toDelete.forEach(([key]) => requestCache.delete(key));
    }
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
        console.error('刷新数据失败:', error);
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
            console.error('加载数据失败，切换到本地缓存：', error);
            return JSON.parse(localStorage.getItem('wh_claims_db_pro')) || [];
        } else {
            localStorage.setItem('wh_claims_db_pro', JSON.stringify(data || []));
            return data || [];
        }
    } catch (error) {
        console.error('加载数据异常：', error);
        return JSON.parse(localStorage.getItem('wh_claims_db_pro')) || [];
    }
}

/**
 * 服务端分页数据获取函数（性能优化版）
 * 从Supabase获取表格数据（支持分页、筛选、排序、字段筛选）
 */
async function fetchTableData(append = false) {
    if (!supabaseClient) return;
    
    // 【性能优化】检查缓存（只在非追加模式下使用缓存）
    if (!append) {
        cleanExpiredCache();
        const cacheKey = getCacheKey(
            ListState.pagination.page,
            ListState.pagination.pageSize,
            ListState.filters,
            ListState.sorting
        );
        const cached = requestCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            // 使用缓存数据
            ListState.data = cached.data;
            ListState.totalCount = cached.totalCount;
            setDbConnectionState('connected');
            renderDatabase();
            renderPaginationControls();
            return;
        }
    }
    
    // 取消上一个请求
    if (currentFetchController) {
        currentFetchController.abort();
    }
    
    // 创建新的请求控制器和ID
    currentFetchController = new AbortController();
    const requestId = ++fetchRequestId;
    
    try {
        ListState.isLoading = true;
        
        const start = (ListState.pagination.page - 1) * ListState.pagination.pageSize;
        const end = start + ListState.pagination.pageSize - 1;
        
        // 【性能优化】只查询可见列对应的字段，减少数据传输量
        const fieldsToSelect = getRequiredFieldsForVisibleColumns();
        
        // 构建查询
        let query = supabaseClient
            .from('claims_v2')
            .select(fieldsToSelect, { count: 'exact' })
            .order(ListState.sorting.col, { ascending: ListState.sorting.asc });
        
        // 应用筛选
        if (ListState.filters.status !== 'all') {
            query = query.eq('process_status', ListState.filters.status);
        }
        
        if (ListState.filters.type !== 'all') {
            query = query.eq('claim_type', ListState.filters.type);
        }
        
        // 【高级搜索重构】应用高级筛选条件
        if (ListState.filters.advancedFilters) {
            query = applyAdvancedFilters(query, ListState.filters.advancedFilters);
        }
        
        // 【搜索功能增强】应用快速搜索条件
        if (ListState.filters.search && ListState.filters.search.trim()) {
            query = applySearchConditions(query, ListState.filters);
        }
        
        query = query.range(start, end);
        
        const { data, count, error } = await query;
        
        // 检查请求是否已被取消或被新请求替换
        if (requestId !== fetchRequestId) {
            console.log('请求已被新请求替换，忽略此响应');
            return;
        }
        
        if (error) {
            throw error;
        }
        
        const newData = data || [];
        ListState.data = append ? [...ListState.data, ...newData] : newData;
        ListState.totalCount = count || 0;
        setDbConnectionState('connected');
        
        // 【性能优化】缓存查询结果（只在非追加模式下缓存）
        if (!append) {
            const cacheKey = getCacheKey(
                ListState.pagination.page,
                ListState.pagination.pageSize,
                ListState.filters,
                ListState.sorting
            );
            requestCache.set(cacheKey, {
                data: newData,
                totalCount: count || 0,
                timestamp: Date.now()
            });
        }
        
        renderDatabase();
        renderPaginationControls();
        
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('数据请求已取消');
            return;
        }
        
        if (requestId !== fetchRequestId) {
            return;
        }
        
        console.error('获取分页数据异常：', error);
        
        // 降级到本地缓存
        const localData = JSON.parse(localStorage.getItem('wh_claims_db_pro')) || [];
        const start = (ListState.pagination.page - 1) * ListState.pagination.pageSize;
        const end = start + ListState.pagination.pageSize - 1;
        const localPageData = localData.slice(start, end + 1);
        
        ListState.data = append ? [...ListState.data, ...localPageData] : localPageData;
        ListState.totalCount = localData.length;
        setDbConnectionState('error');
        
        renderDatabase();
        renderPaginationControls();
    } finally {
        if (requestId === fetchRequestId) {
            ListState.isLoading = false;
            currentFetchController = null;
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
    const advancedSearch = filters.advancedSearch;
    
    // 如果使用高级搜索
    if (advancedSearch && Array.isArray(advancedSearch) && advancedSearch.length > 0) {
        return applyAdvancedSearch(query, advancedSearch);
    }
    
    // 简单搜索模式
    // 确定要搜索的字段
    let fieldsToSearch = [];
    
    if (searchField === 'all') {
        // 搜索所有可搜索字段
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
    
    // 海外仓单号
    if (filters.order_no) {
        query = query.ilike('order_no', `%${filters.order_no}%`);
    }
    
    // 物流运单号
    if (filters.tracking_no) {
        query = query.ilike('tracking_no', `%${filters.tracking_no}%`);
    }
    
    // 发货仓
    if (filters.warehouse) {
        query = query.eq('warehouse', filters.warehouse);
    }
    
    // 订单SKU
    if (filters.sku) {
        query = query.ilike('sku', `%${filters.sku}%`);
    }
    
    // 发货日期范围
    if (filters.ship_date_start) {
        query = query.gte('ship_date', filters.ship_date_start);
    }
    if (filters.ship_date_end) {
        query = query.lte('ship_date', filters.ship_date_end);
    }
    
    // 申请提交日期范围
    if (filters.entry_date_start) {
        query = query.gte('entry_date', filters.entry_date_start);
    }
    if (filters.entry_date_end) {
        query = query.lte('entry_date', filters.entry_date_end);
    }
    
    // 索赔类型
    if (filters.claim_type) {
        query = query.eq('claim_type', filters.claim_type);
    }
    
    return query;
}

/**
 * 应用高级搜索条件（支持字段指定和组合条件）
 * @param {Object} query - Supabase 查询对象
 * @param {Array} conditions - 高级搜索条件数组
 * @returns {Object} 修改后的查询对象
 */
function applyAdvancedSearch(query, conditions) {
    // 高级搜索格式：
    // conditions = [
    //   { field: 'order_no', value: 'ABC123', mode: 'fuzzy', operator: 'AND' },
    //   { field: 'process_status', value: '待审核', mode: 'exact', operator: 'OR' }
    // ]
    
    // 分离AND和OR条件
    const andConditions = [];
    const orConditions = [];
    
    conditions.forEach((condition) => {
        const { field, value, mode = 'fuzzy', operator = 'AND' } = condition;
        
        if (!field || !value || !value.trim()) {
            return; // 跳过无效条件
        }
        
        const fieldConfig = (typeof window !== 'undefined' && window.SEARCH_FIELD_MAP) ? 
            window.SEARCH_FIELD_MAP[field] : null;
        
        if (!fieldConfig || !fieldConfig.searchable) {
            return; // 跳过不可搜索的字段
        }
        
        const searchValue = value.trim();
        
        if (operator === 'OR') {
            orConditions.push({ field, value: searchValue, mode, fieldConfig });
        } else {
            andConditions.push({ field, value: searchValue, mode, fieldConfig });
        }
    });
    
    // 先应用AND条件
    andConditions.forEach(({ field, value, mode, fieldConfig }) => {
        // 【修复】日期类型字段不支持文本搜索
        if (fieldConfig.type === 'date') {
            // 如果搜索值看起来像日期，尝试日期匹配
            const dateMatch = value.match(/^\d{4}-\d{2}-\d{2}/);
            if (dateMatch) {
                try {
                    const dateValue = new Date(value);
                    if (!isNaN(dateValue.getTime())) {
                        query = query.eq(field, value.split(' ')[0]); // 只取日期部分
                    }
                } catch (e) {
                    // 日期解析失败，跳过此条件
                }
            }
            return; // 跳过日期字段的文本搜索
        }
        
        if (mode === 'exact') {
            if (fieldConfig.type === 'number') {
                const numValue = parseFloat(value);
                if (!isNaN(numValue)) {
                    query = query.eq(field, numValue);
                }
            } else {
                // 文本字段精确匹配
                query = query.eq(field, value);
            }
        } else {
            // 模糊搜索
            // 【修复】数字字段不能使用ilike，需要特殊处理
            if (fieldConfig.type === 'number') {
                // 尝试将搜索值转换为数字
                const numValue = parseFloat(value);
                if (!isNaN(numValue)) {
                    // 如果转换成功，使用等号精确匹配
                    query = query.eq(field, numValue);
                }
                // 如果转换失败，跳过这个字段
            } else {
                // 文本字段使用模糊匹配
                const searchPattern = `%${value.toLowerCase()}%`;
                query = query.ilike(field, searchPattern);
            }
        }
    });
    
    // 再应用OR条件（如果有）
    if (orConditions.length > 0) {
        const orQueries = orConditions.map(({ field, value, mode, fieldConfig }) => {
            // 【修复】日期类型字段不支持文本搜索
            if (fieldConfig.type === 'date') {
                // 如果搜索值看起来像日期，尝试日期匹配
                const dateMatch = value.match(/^\d{4}-\d{2}-\d{2}/);
                if (dateMatch) {
                    try {
                        const dateValue = new Date(value);
                        if (!isNaN(dateValue.getTime())) {
                            return `${field}.eq.${value.split(' ')[0]}`;
                        }
                    } catch (e) {
                        // 日期解析失败，跳过
                    }
                }
                return null; // 跳过日期字段的文本搜索
            }
            
            if (mode === 'exact') {
                if (fieldConfig.type === 'number') {
                    const numValue = parseFloat(value);
                    if (!isNaN(numValue)) {
                        return `${field}.eq.${numValue}`;
                    }
                    return null;
                } else {
                    // 文本字段精确匹配
                    return `${field}.eq.${value}`;
                }
            } else {
                // 模糊搜索
                // 【修复】数字字段不能使用ilike
                if (fieldConfig.type === 'number') {
                    // 尝试将搜索值转换为数字
                    const numValue = parseFloat(value);
                    if (!isNaN(numValue)) {
                        // 如果转换成功，使用等号精确匹配
                        return `${field}.eq.${numValue}`;
                    }
                    // 如果转换失败，跳过这个字段
                    return null;
                } else {
                    // 文本字段使用模糊匹配
                    const searchPattern = `%${value.toLowerCase()}%`;
                    return `${field}.ilike.${searchPattern}`;
                }
            }
        }).filter(q => q !== null);
        
        if (orQueries.length > 0) {
            query = query.or(orQueries.join(','));
        }
    }
    
    return query;
}

// 将 fetchTableData 暴露到全局，供 HTML 中的 onclick 等直接调用
if (typeof window !== 'undefined') {
    window.fetchTableData = fetchTableData;
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
            console.error("Missing ID for new record");
            return;
        }

        const { data, error } = await supabaseClient
            .from('claims_v2')
            .insert([dataToSave])
            .select();
        
        if (error) {
            console.error('保存数据到Supabase失败：', error);
            showToast('云端保存失败: ' + error.message, 'error');
            localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
        } else {
            console.log('数据成功保存到Supabase！');
            showToast('数据已同步至云端', 'success');
        }
    } catch (error) {
        console.error('保存数据异常：', error);
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
            console.log('数据成功更新到Supabase');
            showToast('云端数据已更新', 'success');
            return true;
        }
    } catch (error) {
        console.error('更新数据异常：', error);
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
            console.log('数据成功从Supabase删除');
            database = database.filter(item => item.id !== id);
            localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
        }
    } catch (error) {
        console.error('删除数据异常：', error);
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
            console.error('获取表信息失败：', tableError);
        } else {
            console.log('表结构检查成功，表中现有数据行数：', tableInfo.length);
        }
    } catch (error) {
        console.error('检查表结构异常：', error);
    }
}

/**
 * 从Supabase加载所有用户数据（从users_v2表）
 * 此函数用于"用户管理"模块
 */
async function loadUsersFromSupabase() {
    // 显示加载状态
    if (typeof showLoading === 'function') {
        showLoading('正在加载用户数据...');
    }
    
    try {
        if (!supabaseClient) {
            console.error('Supabase客户端未初始化');
            if (typeof hideLoading === 'function') {
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
            console.error('加载用户列表出错:', error);
            
            // 隐藏加载状态
            if (typeof hideLoading === 'function') {
                hideLoading();
            }
            
            // 针对42P17错误（无限递归策略）进行特殊处理
            if (error.code === '42P17') {
                console.error('数据库策略存在无限递归问题，请检查users_v2表的RLS策略');
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
                        console.warn('解析用户权限 JSON 失败:', e, user.permissions);
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
        
        // 隐藏加载状态
        if (typeof hideLoading === 'function') {
            hideLoading();
        }
        
        console.log(`成功加载 ${formattedUsers.length} 个用户`);
        return true;
    } catch (error) {
        console.error('加载用户数据时发生异常:', error);
        if (typeof hideLoading === 'function') {
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

