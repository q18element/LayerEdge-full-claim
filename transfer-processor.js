const fs = require("fs").promises;
const csv = require("csv-parser");
const createCsvWriter = require("csv-writer").createObjectCsvWriter;
const { HttpsProxyAgent } = require("https-proxy-agent");
const { ethers } = require("ethers");
const config = require("./config.json");
class ProxyIterator {
  constructor(proxies) {
    this.proxies = proxies;
    this.currentIndex = 0;
    this.mutex = false;
  }

  async getNextProxy() {
    // Simple mutex implementation
    while (this.mutex) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    this.mutex = true;

    try {
      if (this.proxies.length === 0) return null;

      const startIndex = this.currentIndex;
      let attempts = 0;

      while (attempts < this.proxies.length) {
        const proxy = this.proxies[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.proxies.length;

        // Validate proxy before returning
        this.mutex = false;

        const isValid = await this.validateSingleProxy(proxy);
        if (isValid) {
          return proxy;
        }

        attempts++;

        // If we've tried all proxies and none work, return null
        if (this.currentIndex === startIndex) {
          console.log(`⚠️ All ${this.proxies.length} proxies failed validation`);
          return null;
        }
        this.mutex = true;
      }

      return null;
    } finally {
      this.mutex = false;
    }
  }

  async validateSingleProxy(proxy) {
    try {
      const axios = require("axios");
      const { HttpsProxyAgent } = require("https-proxy-agent");

      const agent = new HttpsProxyAgent(proxy);
      const response = await axios.get("https://httpbin.org/ip", {
        httpsAgent: agent,
        timeout: 5000, // Quick validation
      });

      if (response.status === 200) {
        console.log(`✓ Proxy validated: ${proxy} (IP: ${response.data.origin})`);
        return true;
      } else {
        console.log(`✗ Proxy failed validation: ${proxy} (Status: ${response.status})`);
        return false;
      }
    } catch (error) {
      console.log(`✗ Proxy failed validation: ${proxy} - ${error.message}`);
      return false;
    }
  }
}
// Async Pool class for concurrent processing
class AsyncPool {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

  async add(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    this.running++;
    const { task, resolve, reject } = this.queue.shift();

    try {
      const result = await task();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.running--;
      this.process();
    }
  }
}

class TransferProcessor {
  constructor() {
    this.proxies = [];
    this.proxyIterator = null;
    this.existingResults = new Set();
    this.results = [];
    this.logFile = "transfer_processor.log";
    this.pool = new AsyncPool(config.processing.maxConcurrent);
    this.batchSize = config.processing.batchSize;
    this.isRunning = false;
    this.proxyMutex = false;
  }

  async log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;

    // Write to console
    console.log(`[${timestamp}] ${message}`);

    // Write to file
    try {
      await fs.appendFile(this.logFile, logMessage);
    } catch (error) {
      console.error("Failed to write to log file:", error.message);
    }
  }

  async loadProxies() {
    try {
      const proxyData = await fs.readFile(config.files.proxiesFile, "utf8");
      const allProxies = proxyData
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));

      await this.log(`Found ${allProxies.length} proxies in file`);

      // Validate proxies
      this.proxies = [];
      for (const proxy of allProxies) {
        try {
          new URL(`http://${proxy}`);
          this.proxies.push(proxy);
        } catch (error) {
          await this.log(`Invalid proxy format: ${proxy}`);
        }
      }

      await this.log(`Loaded ${this.proxies.length} valid proxies`);
      this.proxyIterator = this.createProxyIterator();
    } catch (error) {
      await this.log(`No proxy file found or error reading it: ${error.message}`);
      this.proxies = [];
    }
  }

  createProxyIterator() {
    let index = 0;
    return new ProxyIterator(this.proxies);
  }

  async getNextProxy() {
    return this.proxyIterator.getNextProxy();
  }

  async loadDataFromCSV() {
    try {
      const data = [];

      await new Promise((resolve, reject) => {
        const stream = require("fs").createReadStream("data.csv");
        stream
          .pipe(csv())
          .on("data", (row) => {
            // Skip comment lines
            if (row.seedPhrase && !row.seedPhrase.startsWith("#") && row.toAddress) {
              data.push({
                seedPhrase: row.seedPhrase.trim(),
                toAddress: row.toAddress.trim(),
              });
            }
          })
          .on("end", resolve)
          .on("error", reject);
      });

      await this.log(`Loaded ${data.length} transfer records from data.csv`);
      return data;
    } catch (error) {
      throw new Error(`Could not load data from data.csv: ${error.message}`);
    }
  }

  async loadExistingResults() {
    try {
      const existingData = [];
      const fileExists = await fs
        .access("transfer_results.csv")
        .then(() => true)
        .catch(() => false);

      if (!fileExists) {
        await this.log("No existing transfer results file found");
        return;
      }

      await new Promise((resolve, reject) => {
        const stream = require("fs").createReadStream("transfer_results.csv");
        stream
          .pipe(csv())
          .on("data", (row) => {
            existingData.push(row);
            if (row.fromAddress) {
              this.existingResults.add(row.fromAddress);
            }
          })
          .on("end", resolve)
          .on("error", reject);
      });

      await this.log(`Loaded ${existingData.length} existing transfer results`);
      this.results = existingData;
    } catch (error) {
      await this.log(`No existing transfer results file found or error reading it: ${error.message}`);
    }
  }

  async transferETH(seedPhrase, toAddress, retryCount = 0) {
    // Generate address from seed phrase
    const wallet = ethers.Wallet.fromPhrase(seedPhrase);
    const fromAddress = wallet.address;

    try {
      // Get proxy for RPC calls
      const proxy = config.processing.proxyRotation ? await this.getNextProxy() : null;

      // Create provider for LayerEdge network (chainId: 4207) with proxy support
      let provider;
      if (proxy) {
        const fetchRequest = new ethers.FetchRequest("https://rpc.layeredge.io");
        fetchRequest.setHeader("User-Agent", config.headers["user-agent"]);

        // Create HTTP agent with proxy
        const agent = new HttpsProxyAgent(proxy);
        fetchRequest.getUrlFunc = ethers.FetchRequest.createGetUrlFunc({ agent });

        provider = new ethers.JsonRpcProvider(fetchRequest);
      } else {
        provider = new ethers.JsonRpcProvider("https://rpc.layeredge.io");
      }

      const walletWithProvider = wallet.connect(provider);

      // Step 1: Get balance
      const balance = await provider.getBalance(fromAddress);
      const balanceInEth = ethers.formatEther(balance);

      if (balance === 0n) {
        // Get nonce even for zero balance for logging
        const nonce = await provider.getTransactionCount(fromAddress);
        await this.log(`⚠️ No ETH balance in ${fromAddress} (nonce: ${nonce})`);
        return {
          success: true,
          data: {
            message: "No balance to transfer",
            balance: "0",
            nonce: nonce,
          },
          fromAddress: fromAddress,
          toAddress: toAddress,
        };
      }

      // Step 2: Get nonce
      const nonce = await provider.getTransactionCount(fromAddress);

      // Step 3: Estimate gas
      const gasPrice = await provider.getFeeData();
      const estimatedGas = 21000n; // Standard ETH transfer gas
      const gasCost = estimatedGas * gasPrice.gasPrice;

      // Step 4: Calculate amount to send (balance - gas cost)
      const amountToSend = balance - gasCost;

      if (amountToSend <= 0n) {
        await this.log(`⚠️ Insufficient balance to cover gas fees in ${fromAddress} (nonce: ${nonce})`);
        return {
          success: true,
          data: {
            message: "Insufficient balance for gas",
            balance: balanceInEth,
            nonce: nonce,
          },
          fromAddress: fromAddress,
          toAddress: toAddress,
        };
      }

      const amountInEth = ethers.formatEther(amountToSend);
      await this.log(`📤 Sending ${amountInEth} ETH from ${fromAddress} to ${toAddress} (nonce: ${nonce})`);

      // Step 5: Create and send transaction
      const tx = {
        to: toAddress,
        value: amountToSend,
        gasLimit: estimatedGas,
        gasPrice: gasPrice.gasPrice,
        nonce: nonce,
      };

      const txResponse = await walletWithProvider.sendTransaction(tx);
      await this.log(`⏳ Transaction sent: ${txResponse.hash} (nonce: ${nonce})`);

      // Step 6: Wait for confirmation
      const receipt = await txResponse.wait();

      if (receipt.status === 1) {
        await this.log(
          `✅ Transfer SUCCESS: ${amountInEth} ETH sent from ${fromAddress} to ${toAddress} (nonce: ${nonce})`
        );
        return {
          success: true,
          data: {
            txHash: txResponse.hash,
            amount: amountInEth,
            gasUsed: receipt.gasUsed.toString(),
            status: "confirmed",
            nonce: nonce,
          },
          fromAddress: fromAddress,
          toAddress: toAddress,
        };
      } else {
        throw new Error(`Transaction failed with status: ${receipt.status}`);
      }
    } catch (error) {
      // Error logging
      let errorDetails = `Transfer Error for ${fromAddress}: ${error.message}`;

      if (error.code) {
        errorDetails += ` - Code: ${error.code}`;
      }
      if (error.reason) {
        errorDetails += ` - Reason: ${error.reason}`;
      }

      await this.log(errorDetails);

      if (retryCount < config.api.maxRetries) {
        await this.log(
          `Retry ${retryCount + 1}/${config.api.maxRetries} for Transfer ${fromAddress} in ${config.api.retryDelay}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, config.api.retryDelay));
        return this.transferETH(seedPhrase, toAddress, retryCount + 1);
      } else {
        await this.log(`Max retries reached for Transfer ${fromAddress}. Giving up.`);
        return {
          success: false,
          error: error.message,
          code: error.code,
          reason: error.reason,
          fromAddress: fromAddress,
          toAddress: toAddress,
        };
      }
    }
  }

  async processTransferRecord(record, index, total) {
    const { seedPhrase, toAddress } = record;

    // Generate address from seed phrase to check if already processed
    const wallet = ethers.Wallet.fromPhrase(seedPhrase);
    const fromAddress = wallet.address;

    // Check if this address was already processed
    if (config.processing.skipExisting && this.existingResults.has(fromAddress)) {
      await this.log(`Skipping ${fromAddress} (${index + 1}/${total}) - already processed`);
      return null;
    }

    await this.log(`Processing transfer ${index + 1}/${total}: ${fromAddress} -> ${toAddress}`);

    // Add delay between requests to avoid rate limiting
    if (config.processing.delayBetweenRequests && index > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.processing.delayBetweenRequests));
    }

    const result = await this.transferETH(seedPhrase, toAddress);

    const csvRow = {
      fromAddress: result.fromAddress || fromAddress,
      toAddress: result.toAddress || toAddress,
      data: JSON.stringify(result.data || { error: result.error }),
    };

    this.results = this.results || [];
    this.results.push(csvRow);

    if (result.success) {
      if (result.data.amount) {
        await this.log(`💰 Transfer Success: ${result.data.amount} ETH sent from ${fromAddress} to ${toAddress}`);
      } else {
        await this.log(`✅ Transfer Success: ${result.data.message}`);
      }
    } else {
      await this.log(`❌ Transfer Failed: ${result.error}`);
    }

    // Save result immediately after processing
    await this.saveResultsImmediate();

    return csvRow;
  }

  async saveResultsImmediate() {
    try {
      const csvWriter = createCsvWriter({
        path: "transfer_results.csv",
        header: [
          { id: "fromAddress", title: "FromAddress" },
          { id: "toAddress", title: "ToAddress" },
          { id: "data", title: "Data" },
        ],
      });

      // Write all results
      await csvWriter.writeRecords(this.results || []);

      // Log only for significant milestones to avoid spam
      if ((this.results?.length || 0) % 10 === 0) {
        await this.log(`💾 Transfer Results saved: ${this.results?.length || 0} total records in transfer_results.csv`);
      }
    } catch (error) {
      await this.log(`❌ Error saving transfer results: ${error.message}`);
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      totalProxies: this.proxies.length,
      totalResults: this.results.length,
      batchSize: this.batchSize,
    };
  }
}

module.exports = TransferProcessor;
