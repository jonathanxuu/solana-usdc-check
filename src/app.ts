import express from 'express';

const app = express();
app.use(express.json());

// 客户端 HTTP 服务器
app.post('/notify', (req, res) => {
    const { transaction } = req.body;
    console.log('Received transaction:', transaction);
    res.sendStatus(200);
});

const PORT = 6013;
app.listen(PORT, () => {
    console.log(`Client server is running on http://localhost:${PORT}`);
});
