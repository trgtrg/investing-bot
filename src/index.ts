import dotenv from 'dotenv';
import isEqual from 'lodash/isEqual'
import http from 'http';

dotenv.config();

import { runBot, sendTgMessage } from './bot';
import { initDB, sequelize }from './db';
import Stock from './db/models/stock';
import User from './db/models/user';
import { collectStockEarnings, StockEarning } from './utils/stocks-collector';

const INTERVAL_MS = 1000 * 60 * 2;

async function initServer() {
    await initDB(<string>process.env.DATABASE_URL);

    if (process.env.NODE_ENV === 'production') {
        await runBot();
    }

    checkEarningUpdates();
    setInterval(checkEarningUpdates, INTERVAL_MS);

    http.createServer((_, res) => {
        res.writeHead(200);
        res.end();
    }).listen(process.env.PORT);
}

let prevStockEarnings: Map<string | null, StockEarning>;
async function checkEarningUpdates() {
    const stockEarnings = await collectStockEarnings();

    if (!prevStockEarnings) {
        prevStockEarnings = stockEarnings;

        return;
    }

    const userChatIds = await User.findAll().map((user: User) => user.get('chatId'));

    const stocks = await Stock.findAll({
        where: {
            ticker: Array.from(stockEarnings.keys())
        }
    });

    for (let stock of stocks) {
        try {
            const ticker = stock.get('ticker');
            const name = stock.get('name');
            const earning = stockEarnings.get(ticker);
            const prevEarning = prevStockEarnings.get(ticker);
            const lastEarningDate = stock.get('lastEarningDate');

            if (!earning || !prevEarning) continue;
            if (isEqual(earning, prevEarning)) continue;

            const [[{similarity}]] = await sequelize.query(
                `SELECT similarity from similarity(` +
                    `E'${name.replace(/'/g,'\\\'')}',` +
                    `E'${earning.name.replace(/'/g,'\\\'')}'` +
                `);`
            );

            if (Number(similarity) < 0.3) continue;

            const today = new Date();

            today.setHours(0, 0, 0, 0);

            console.log(earning, prevEarning, similarity, name, lastEarningDate, today, lastEarningDate === today);

            if (lastEarningDate && lastEarningDate >= today) continue;

            if (earning.earningShowed) {
                await stock.update({
                    lastEarningDate: today
                });
            }

            for (let chatId of userChatIds) {
                await sendTgMessage(
                    `📊[${earning.showName}](${earning.link})📊\n` +
                    `EPS: ${earning.epsFact} / ${earning.epsForecast} ` +
                    `${earning.epsPositive ? '✅' : ''}${earning.epsNegative ? '❌' : ''}\n` +
                    `Income: ${earning.incomeFact} / ${earning.incomeForecast} ` +
                    `${earning.incomePositive ? '✅' : ''}${earning.incomeNegative ? '❌' : ''}`,
                    chatId,
                    {disable_web_page_preview: true}
                )
            }
        } catch(e) {
            console.error(e);

            const adminChatIds = await User.findAll({where: {isAdmin: true}}).map((user: User) => user.get('chatId'));

            for (let chatId of adminChatIds) {
                await sendTgMessage(
                    JSON.stringify(e.message, null, 4),
                    chatId,
                );
            }
        }
    }

    prevStockEarnings = stockEarnings;
}

initServer();
