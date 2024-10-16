import {
    Connection,
    PublicKey,
    ParsedInstruction,
} from '@solana/web3.js';
import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import express from 'express';
import axios from 'axios';

dotenv.config();

const USDC_MINT_ADDRESS = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'; // Devnet 上 USDC 的 Mint 地址

const mongoURI = 'mongodb://mongoadmin:secret@localhost:27017/?authSource=admin';
const app = express();
app.use(express.json());

// 交易模型
const transactionSchema = new mongoose.Schema({
    txHash: String,
    from: String,
    to: String,
    amount: Number,
    address: String,
    time: Number,
});

const dbTransaction = mongoose.model('Transaction', transactionSchema);

// MongoDB 连接
async function connectToDatabase() {
    try {
        await mongoose.connect(mongoURI, {
            bufferCommands: false,
        });
        console.log('MongoDB connected...');
    } catch (err) {
        console.error('MongoDB connection error:', err);
    }
}

// 保存交易
async function saveTransaction(transaction: any) {
    const existingTransaction = await dbTransaction.findOne({ txHash: transaction.txHash });
    if (existingTransaction) {
        console.log('Transaction already exists in MongoDB:', transaction.txHash);
        return false; // 如果已存在，返回 false
    }

    const newTransaction = new dbTransaction(transaction);
    await newTransaction.save();
    console.log('Transaction saved to MongoDB:', transaction);
    return true; // 返回 true 表示已保存
}

// 查询最近的 USDC 交易
async function getRecentUSDCTransactions(recipient: string) {
    try {
        const connection = new Connection('https://black-side-dawn.solana-devnet.quiknode.pro/34914fab50708164e45c152a3bb6135d85ae7611', {
            commitment: 'confirmed',
            wsEndpoint: 'wss://black-side-dawn.solana-devnet.quiknode.pro/34914fab50708164e45c152a3bb6135d85ae7611',
        });

        const recipientPublicKey = new PublicKey(recipient);
        const tokenAccountsResponse = await connection.getTokenAccountsByOwner(recipientPublicKey, {
            mint: new PublicKey(USDC_MINT_ADDRESS),
        });

        const tokenAccounts = tokenAccountsResponse.value;
        if (tokenAccounts.length === 0) {
            console.log('No USDC token accounts found for this address.');
            return null;
        }

        const signatures: string[] = [];
        const { pubkey } = tokenAccounts[0];
        const accountSignatures = await connection.getSignaturesForAddress(pubkey, {
            limit: 1,
        });

        if (accountSignatures.length === 0) {
            console.log('No transactions found for USDC token accounts.');
            return null;
        }

        signatures.push(...accountSignatures.map(sig => sig.signature));
        const transactionDetails = await connection.getParsedTransaction(signatures[0], 'confirmed');
        if (!transactionDetails) return null;

        const { transaction, meta } = transactionDetails;
        const instructions = transaction.message.instructions;

        const usdcTransfer = instructions.find(instruction => {
            if ('parsed' in instruction) {
                const parsedInstruction = instruction as ParsedInstruction;
                return (
                    parsedInstruction?.parsed?.type === 'transferChecked' &&
                    parsedInstruction?.parsed?.info?.mint === USDC_MINT_ADDRESS
                );
            }
            return false;
        });

        if (usdcTransfer && 'parsed' in usdcTransfer) {
            const parsedInstruction = usdcTransfer as ParsedInstruction;
            const fromAddress = parsedInstruction.parsed.info.source;
            const toAddress = parsedInstruction.parsed.info.destination;
            const tokenAmount = parsedInstruction.parsed.info.tokenAmount;

            const amount = Number(tokenAmount.amount) / 10 ** tokenAmount.decimals; // 计算实际金额
            const slot = transactionDetails.slot; // 注意这里要从 transactionDetails 中获取 slot
            const timestamp = (await connection.getBlockTime(slot)) || 0; // 使用 slot 获取时间戳

            return {
                txHash: signatures[0],
                from: fromAddress,
                to: toAddress,
                address: recipient,
                amount,
                time: timestamp,
            };
        }

        return null;
    } catch (error) {
        console.error('Error fetching USDC transaction:', error);
    }
}

// HTTP 请求处理
app.post('/monitor', async (req: any, res: any) => {
    const { recipient } = req.body;
    if (!recipient) {
        return res.status(400).json({ error: 'Recipient address is required.' });
    }

    await connectToDatabase(); // 连接数据库
    console.log("Monitoring transactions for:", recipient);

    const interval = setInterval(async () => {
        const currentTransaction = await getRecentUSDCTransactions(recipient);
        if (currentTransaction) {
            const isSaved = await saveTransaction(currentTransaction);
            if (isSaved) {
                console.log('New USDC transaction detected:', currentTransaction);
                // 向客户端发送 POST 请求
                try {
                    await axios.post('http://localhost:6013/notify', {
                        transaction: currentTransaction,
                    });
                    console.log('Transaction notification sent to client.');
                } catch (error) {
                    console.error('Error sending notification to client:', error);
                }

                res.json({ action: 'newTransaction', transaction: currentTransaction });
                clearInterval(interval); // 2分钟内查到则中断查询
            }
        }
    }, 10000); // 每 20 秒查询一次

    // 设置 5 分钟超时
    setTimeout(() => {
        clearInterval(interval);
        console.log('Monitoring ended due to timeout for:', recipient);
    }, 2 * 60 * 1000); // 2 分钟
});

const PORT = 6012;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});


app.get('/transactions/:count', async (req, res) => {
    const { count } = req.params;
    await connectToDatabase(); // 连接数据库

    try {
        const transactions = await dbTransaction.find({})
            .sort({ time: -1 }) // 按时间降序排序
            .limit(parseInt(count)) // 限制返回的记录数量
            .exec();

        res.json(transactions);
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});