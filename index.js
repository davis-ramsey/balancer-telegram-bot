const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const token = require('./keys');
const transactions = require('./repository');

const bot = new TelegramBot(token, { polling: true });

let swaps;
let address = [];
let chatId;
let i = 0;
const poolInfo = {};
let dayFees = 0;

getPool = function(address, ownership = 1) {
	//gets current token balances for selected balancer pool
	axios({
		url: 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer',
		method: 'post',
		data: {
			query: `{
      pools(where: {id: "${address.toLowerCase()}"
    }) {
        id
        swapFee
        totalWeight
        tokensList
        tokens {
          id
          address
          decimals
          balance
          symbol
          denormWeight
        }
      }
    }
    `
		}
	})
		.then(({ data }) => {
			const id = {
				swapFee: data.data.pools[0].swapFee,
				ownership: Number(ownership),
				tokenBalance: [],
				tokenAddr: [],
				tokenNames: [],
				tokenPrice: {}
			};

			const tokens = data.data.pools[0].tokens;
			for (let element of tokens) {
				id.tokenBalance.push(parseFloat(element.balance).toFixed(2));
				id.tokenAddr.push(element.address);
				id.tokenNames.push(element.symbol);
			}
			poolInfo[address] = id;
			getPrice(address);
		})
		.catch((err) => {
			console.log(err);
		});
};

getSwaps = function(address) {
	//gets current token swaps for selected balancer pool
	axios({
		url: 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer',
		method: 'post',
		data: {
			query: `{
      pools(where: {id: "${address.toLowerCase()}"
    }) {
        swaps(first: 5, skip: 0, orderBy: timestamp, orderDirection: desc) {
			timestamp
			tokenIn
			tokenInSym
			tokenAmountIn
			tokenOut
			tokenOutSym
			tokenAmountOut
        }
      }
    }
    `
		}
	})
		.then(({ data }) => {
			swaps = data.data.pools[0].swaps;
		})
		.catch((err) => {
			console.log(err);
		});
};
loop = (i) => {
	setInterval(async () => {
		await getSwaps(address[i]);
		setTimeout(async () => {
			for (let swap of swaps) {
				if (!await transactions.getOne(swap.timestamp)) {
					const num1 =
						Number(swap.tokenAmountIn).toFixed(4) *
						poolInfo[address[i]].tokenPrice[swap.tokenInSym.toLowerCase()];
					const num2 =
						Number(swap.tokenAmountOut).toFixed(4) *
						poolInfo[address[i]].tokenPrice[swap.tokenOutSym.toLowerCase()];
					let fees = 0;
					let total = 0;
					if (num1 > num2) {
						fees = (num1 * poolInfo[address[i]].swapFee).toFixed(2) * poolInfo[address[i]].ownership;
						total = num1.toFixed(2);
					} else {
						fees = (num2 * poolInfo[address[i]].swapFee).toFixed(2) * poolInfo[address[i]].ownership;
						total = num2.toFixed(2);
					}
					swap.fee = fees;
					dayFees += Number(fees);
					bot.sendMessage(
						chatId,
						`New Transaction Detected ${Math.floor(
							Date.now() / 1000 - swap.timestamp
						)} seconds ago: ${Number(swap.tokenAmountIn).toFixed(
							2
						)} ${swap.tokenInSym} Swapped in for ${Number(swap.tokenAmountOut).toFixed(
							2
						)} ${swap.tokenOutSym} with value: $${total}. Fees Earned: $${fees.toFixed(2)}`
					);
					await transactions.create(swap);
				}
			}
			await getPool(address[i], poolInfo[address[i]].ownership);
		}, 3000);
		const trades = await transactions.getAll();
		for (let trade of trades) {
			if (trade.timestamp < (Date.now() / 1000).toFixed(0) - 86400) {
				await transactions.delete(trade.id);
				dayFees = dayFees - Number(trade.fee);
			}
		}
	}, 60000);
};

getPrice = function(address) {
	for (let i = 0; i < poolInfo[address].tokenAddr.length; i++) {
		axios({
			url: `https://api.coingecko.com/api/v3/coins/ethereum/contract/${poolInfo[address].tokenAddr[i]}`
		})
			.then((result) => {
				tokenSym = result.data.symbol;
				poolInfo[address].tokenPrice[tokenSym] = result.data.market_data.current_price.usd;
			})
			.catch((err) => {
				console.log(err);
			});
	}
};
bot.on('message', async (msg) => {
	chatId = msg.chat.id;
	const [ string1, string2 ] = msg.text.split(' ');
	address.push(string1);
	await getSwaps(address[i]);
	setTimeout(() => {
		if (swaps) {
			getPool(address[i], string2);
			loop(i);
			bot.sendMessage(chatId, 'Valid Balancer Pool Address confirmed. Starting program...');
			i++;
		} else {
			bot.sendMessage(chatId, 'Invalid Address! Please enter a valid balancer pool address');
			address.pop();
		}
	}, 1000);
	bot.sendMessage(chatId, 'Checking address...');
});
setInterval(() => {
	let portfolioTotal = 0;
	for (let j = 0; j < i; j++) {
		let balance = poolInfo[address[j]].tokenBalance;
		let symbol = poolInfo[address[j]].tokenNames;
		for (let k = 0; k < balance.length; k++) {
			portfolioTotal +=
				parseFloat(balance[k]) *
				poolInfo[address[j]].tokenPrice[symbol[k].toLowerCase()] *
				poolInfo[address[j]].ownership;
		}
	}
	bot.sendMessage(chatId, `Fees earned for last 24 hours: $${dayFees.toFixed(2)}`);
	bot.sendMessage(chatId, `Current Portfolio Value: $${Number(portfolioTotal.toFixed(2)).toLocaleString()}`);
}, 1807686);
