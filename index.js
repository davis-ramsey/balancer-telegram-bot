const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const token = require('./keys');
const transactions = require('./repository');

const bot = new TelegramBot(token, { polling: true });

let swaps; //variable for storing pool transaction history
let address = []; //array of balancer pool addresses being tracked
let i = 0; //counter for the array of addresses
let chatId; //iD of the chat for the bot to send updates to
const poolInfo = {}; // object that contains all relevant balacer pool information for each address

getPool = function(address, userAddress) {
	//gets current pool information for selected balancer pool
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
				totalShares
				tokensList
        tokens {
          id
          address
          decimals
          balance
          symbol
          denormWeight
				}
				shares (first: 1000) {
					id
					userAddress {
						id
					}
					balance
				}
      }
    }
    `
		}
	})
		.then(({ data }) => {
			const id = {
				swapFee: data.data.pools[0].swapFee,
				ownership: userAddress,
				tokenBalance: [],
				tokenAddr: [],
				tokenNames: [],
				tokenPrice: {}
			};
			const shares = data.data.pools[0].shares;
			if (typeof userAddress === 'string') {
				for (let share of shares) {
					if (share.userAddress.id === userAddress.toLowerCase())
						id.ownership = share.balance / data.data.pools[0].totalShares;
				}
			}
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
	//gets current token transactions for selected balancer pool
	axios({
		url: 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer',
		method: 'post',
		data: {
			query: `{
      pools(where: {id: "${address.toLowerCase()}" }) {
				totalShares
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
	//loop that runs every minute.
	setInterval(async () => {
		await getSwaps(address[i]); //query balancer subgraph for recent transactions
		setTimeout(async () => {
			for (let swap of swaps) {
				if (!await transactions.getOne(swap.timestamp)) {
					//if this is a new transaction, process it then print out to telegram
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
			await getPool(address[i], poolInfo[address[i]].ownership); //query balancer subgraph for updated pool information (primarily token balances)
		}, 3000);
		const trades = await transactions.getAll();
		for (let trade of trades) {
			//checks transaction history for transactions older than 1 day. if found, they are removed
			if (trade.timestamp < (Date.now() / 1000).toFixed(0) - 86400) {
				await transactions.delete(trade.id);
			}
		}
	}, 60000);
};

getPrice = function(address) {
	// gets current token prices from coingecko for each token in the pool
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
	//program starts when the bot recieves a message
	chatId = msg.chat.id;
	const [ string1, string2 ] = msg.text.split(' '); // string1 is assumed to be balancer pool address. string2 is user address
	address.push(string1);
	await getSwaps(address[i]); //try to query balancer subgraph with string1
	setTimeout(() => {
		if (swaps) {
			//if query successful, begin loop.
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
setInterval(async () => {
	// runs approx every 30 mins. Calculates total portfolio value and fees earned over the last day.
	const records = await transactions.getAll();
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
	let sumFees = 0;
	for (let element of records) {
		sumFees += element.fee;
	}
	bot.sendMessage(chatId, `Fees earned for last 24 hours: $${sumFees.toFixed(2)}`);
	bot.sendMessage(chatId, `Current Portfolio Value: $${Number(portfolioTotal.toFixed(2)).toLocaleString()}`);
}, 1807686);
