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
    type: String, // 新增字段，用来区分 USDC 和 SOL 交易
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
                type: "USDC"
            };
        }

        return null;
    } catch (error) {
        console.error('Error fetching USDC transaction:', error);
    }
}

// 查询最近的 SOL 交易
async function getRecentSOLTransactions(recipient: string) {
    try {
        const connection = new Connection('https://black-side-dawn.solana-devnet.quiknode.pro/34914fab50708164e45c152a3bb6135d85ae7611', {
            commitment: 'confirmed',
            wsEndpoint: 'wss://black-side-dawn.solana-devnet.quiknode.pro/34914fab50708164e45c152a3bb6135d85ae7611',
        });        const recipientPublicKey = new PublicKey(recipient);
        
        const transactionSignatures = await connection.getSignaturesForAddress(recipientPublicKey, {
            limit: 1,
        });

        if (transactionSignatures.length === 0) {
            console.log('No transactions found for this address.');
            return null;
        }

        const transactionDetails = await connection.getParsedTransaction(transactionSignatures[0].signature, 'confirmed');
        if (!transactionDetails) return null;

        const { transaction, meta } = transactionDetails;
        const instructions = transaction.message.instructions;

        const solTransfer = instructions.find(instruction => {
            if ('parsed' in instruction) {
                const parsedInstruction = instruction as ParsedInstruction;
                return parsedInstruction?.parsed?.type === 'transfer';
            }
            return false;
        });

        if (solTransfer && 'parsed' in solTransfer) {
            const parsedInstruction = solTransfer as ParsedInstruction;
            const fromAddress = parsedInstruction.parsed.info.source;
            const toAddress = parsedInstruction.parsed.info.destination;
            const amount = parsedInstruction.parsed.info.lamports / 10 ** 9; // 转换为 SOL

            const slot = transactionDetails.slot;
            const timestamp = (await connection.getBlockTime(slot)) || 0;

            return {
                txHash: transactionSignatures[0].signature,
                from: fromAddress,
                to: toAddress,
                address: recipient,
                amount,
                time: timestamp,
                type: 'SOL', // 指明交易类型为 SOL
            };
        }

        return null;
    } catch (error) {
        console.error('Error fetching SOL transaction:', error);
    }
}

// HTTP 请求处理
app.post('/monitor', async (req: any, res: any) => {
    const { recipient, type } = req.body; // 从请求中获取 type 参数（USDC 或 SOL）
    if (!recipient) {
        return res.status(400).json({ error: 'Recipient address is required.' });
    }

    await connectToDatabase(); // 连接数据库
    console.log(`Monitoring ${type || 'USDC and SOL'} transactions for:`, recipient);
    let responseSent = false; // Flag to track if a response has been sent

    const interval = setInterval(async () => {
        let usdcTransaction, solTransaction;
        if (type === 'USDC') {
            usdcTransaction = await getRecentUSDCTransactions(recipient);
        } else if (type === 'SOL') {
            solTransaction = await getRecentSOLTransactions(recipient);
        } else {
            // 如果没有指定类型，先查询 USDC，如果没有找到再查询 SOL
            usdcTransaction = await getRecentUSDCTransactions(recipient);
            solTransaction = await getRecentSOLTransactions(recipient);
        }
        const newTransactions = [];

        // 如果查的是 USDC 或者 全部
        if (type !== 'SOL' && usdcTransaction) {
            const usdcSaved = await saveTransaction(usdcTransaction);
            if (usdcSaved) {
                console.log('New USDC transaction detected:', usdcTransaction);
                newTransactions.push(usdcTransaction); // 将 USDC 交易添加到新交易数组
            }
        }
        // 如果查的是 SOL 或者 全部
        if (type !== 'USDC' && solTransaction) {
            const solSaved = await saveTransaction(solTransaction);
            if (solSaved) {
                console.log('New SOL transaction detected:', solTransaction);
                newTransactions.push(solTransaction); // 将 SOL 交易添加到新交易数组
            }
        }

        if (newTransactions.length > 0) {
            // 向客户端发送 POST 请求，通知新交易
            try {
                await axios.post('http://localhost:6013/notify', {
                    transactions: newTransactions, // 发送所有新交易
                });
                console.log('Transaction notification sent to client.');
            } catch (error) {
                console.error('Error sending notification to client:', error);
            }
            if (!responseSent) { // Check if response has already been sent
                res.json({ action: 'newTransactions', transactions: newTransactions });
                responseSent = true; // Set flag to true
                clearInterval(interval); // Clear interval if a transaction was found
            }
        }
    }, 10000); // 每 10 秒查询一次


    // 设置 5 分钟超时
    setTimeout(() => {
        clearInterval(interval);
        if (!responseSent) { // Check again before sending the timeout response
            console.log('Monitoring ended due to timeout for:', recipient);
            res.json({ action: "NoLatestTx", transactions: `No new ${type} transaction, the latest ${type} transaction already returned before and stored in mongoDB` });
            responseSent = true; // Set flag to true
        }
    }, 1 * 60 * 1000); // 2 分钟
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