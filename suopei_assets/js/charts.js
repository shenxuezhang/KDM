/**
 * 图表模块
 * 处理所有图表相关的初始化和更新
 */

// 图表实例
let lineChartInstance = null;
let pieChartInstance = null;

/**
 * 初始化图表
 */
function initCharts() {
    // 检查两个图表实例，防止重复创建
    if (lineChartInstance && pieChartInstance) {
        return;
    }
    
    const months = [];
    const dataPoints = [];
    const today = new Date();
    
    for (let i = 5; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        months.push(`${d.getMonth() + 1}月`);
        const sum = database.filter(item => {
            if (!item.entry_date) return false;
            const parts = item.entry_date.split('-');
            if (parts.length < 2) return false;
            const itemYear = parseInt(parts[0]);
            const itemMonth = parseInt(parts[1]) - 1;
            return itemMonth === d.getMonth() && itemYear === d.getFullYear();
        }).reduce((acc, curr) => acc + (parseFloat(curr.claim_total) || 0), 0);
        dataPoints.push(sum);
    }
    
    // 只在未创建时创建折线图
    if (!lineChartInstance) {
        const lineCtx = document.getElementById('lineChart');
        if (lineCtx) {
            lineChartInstance = new Chart(lineCtx.getContext('2d'), {
                type: 'line',
                data: {
                    labels: months,
                    datasets: [{
                        label: '索赔金额',
                        data: dataPoints,
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16, 185, 129, 0.1)',
                        fill: true,
                        tension: 0.4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { display: true, grid: { display: false } },
                        x: { display: true, grid: { display: false } }
                    }
                }
            });
        }
    }
    
    // 只在未创建时创建饼图
    if (!pieChartInstance) {
        const pieCtx = document.getElementById('pieChart');
        if (pieCtx) {
            pieChartInstance = new Chart(pieCtx.getContext('2d'), {
                type: 'doughnut',
                data: {
                    labels: [],
                    datasets: [{
                        data: [],
                        backgroundColor: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#6366f1']
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    cutout: '70%'
                }
            });
        }
    }
}

// 【性能优化】图表更新节流（300ms）
let chartUpdateThrottleTimer = null;
let pendingChartData = null;

/**
 * 更新饼图数据（节流版本 - 限制更新频率）
 */
function updatePieChartThrottled(data) {
    // 保存最新的数据
    pendingChartData = data;
    
    // 如果已经有待执行的更新，清除它
    if (chartUpdateThrottleTimer) {
        clearTimeout(chartUpdateThrottleTimer);
    }
    
    // 设置新的更新任务
    chartUpdateThrottleTimer = setTimeout(() => {
        if (pendingChartData) {
            updatePieChart(pendingChartData);
            pendingChartData = null;
        }
        chartUpdateThrottleTimer = null;
    }, 300); // 300ms节流
}

/**
 * 更新饼图数据（内部函数 - 实际执行更新）
 */
function updatePieChart(data) {
    if (!pieChartInstance) return;
    const typeCounts = {};
    data.forEach(i => typeCounts[i.claim_type] = (typeCounts[i.claim_type] || 0) + 1);
    pieChartInstance.data.labels = Object.keys(typeCounts);
    pieChartInstance.data.datasets[0].data = Object.values(typeCounts);
    pieChartInstance.update();
    if (lineChartInstance) lineChartInstance.update();
}

// 将节流更新函数暴露到全局，供其他模块调用
if (typeof window !== 'undefined') {
    window.updatePieChartThrottled = updatePieChartThrottled;
    window.updatePieChart = updatePieChart; // 也暴露原始函数，以防需要立即更新
}

