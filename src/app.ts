import express from 'express';

const app = express();
app.use(express.json());

// 客户端 HTTP 服务器
app.post('/notify', (req, res) => {
    const { transactions } = req.body; // 提取 transactions 数组
    if (transactions && transactions.length > 0) {
        // 打印每笔交易
        transactions.forEach((transaction: any) => {
            console.log('Received transaction:', transaction);
        });
        res.sendStatus(200); // 成功响应
    } else {
        console.error('No transactions found in request body.');
        res.status(400).json({ error: 'No transactions provided.' }); // 错误响应
    }
});

const PORT = 6013;
app.listen(PORT, () => {
    console.log(`Client server is running on http://localhost:${PORT}`);
});
