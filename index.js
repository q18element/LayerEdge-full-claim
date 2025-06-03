const fs = require("fs").promises;
const axios = require("axios");
const csv = require("csv-parser");
const createCsvWriter = require("csv-writer").createObjectCsvWriter;
const { HttpsProxyAgent } = require("https-proxy-agent");
const config = require("./config.json");
const { ethers } = require("ethers");

class AsyncPool {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  async add(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        task,
        resolve,
        reject,
      });
      this.process();
    });
  }

  async process() {
    if (this.running >= this.concurrency || this.queue.length === 0) {
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

class LayerEdgeAllocationChecker {
  constructor() {
    this.proxies = [];
    this.proxyIterator = null;
    this.existingResults = new Set();
    this.existingCexResults = new Set(); // For CEX existing results
    this.existingClaimResults = new Set(); // For Claim existing results
    this.existingConsolidateResults = new Set(); // For Consolidate existing results
    this.results = [];
    this.cexResults = [];
    this.claimResults = [];
    this.consolidateResults = [];
    this.logFile = config.files.logFile;
    this.pool = new AsyncPool(config.processing.maxConcurrent); // Max concurrent tasks from config
    this.batchSize = config.processing.batchSize; // Batch size from config
    this.isRunning = false;
  }

  async log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    console.log(message);
    try {
      await fs.appendFile(this.logFile, logMessage);
    } catch (error) {
      console.error("Failed to write to log file:", error.message);
    }
  }

  normalizeProxy(proxy) {
    // If proxy doesn't start with protocol, assume http://
    if (
      !proxy.startsWith("http://") &&
      !proxy.startsWith("https://") &&
      !proxy.startsWith("socks5://") &&
      !proxy.startsWith("socks4://")
    ) {
      return `http://${proxy}`;
    }
    return proxy;
  }

  async loadProxies() {
    try {
      const proxyData = await fs.readFile(config.files.proxiesFile, "utf8");
      this.proxies = proxyData
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((proxy) => this.normalizeProxy(proxy));

      await this.log(`Loaded ${this.proxies.length} proxies`);

      // Initialize proxy iterator (validation happens in getNextProxy)
      if (this.proxies.length > 0) {
        this.proxyIterator = new ProxyIterator(this.proxies);
        await this.log(`✅ Loaded ${this.proxies.length} proxies. Validation will happen on-demand.`);
      }
    } catch (error) {
      await this.log(`Warning: Could not load proxies from ${config.files.proxiesFile}: ${error.message}`);
      await this.log("Continuing without proxies...");
    }
  }

  async validateProxies() {
    await this.log("🔍 Validating proxies in background...");
    const validProxies = [];
    const totalProxies = this.proxies.length;

    // Validate proxies concurrently for faster processing
    const validationTasks = this.proxies.map(async (proxy, index) => {
      try {
        const agent = new HttpsProxyAgent(proxy);
        const response = await axios.get("https://httpbin.org/ip", {
          httpsAgent: agent,
          timeout: 8000, // Shorter timeout for faster validation
        });

        if (response.status === 200) {
          validProxies.push(proxy);
          await this.log(`✓ Proxy ${index + 1}/${totalProxies} working: ${proxy} (IP: ${response.data.origin})`);
          return { proxy, working: true, ip: response.data.origin };
        } else {
          await this.log(`✗ Proxy ${index + 1}/${totalProxies} failed: ${proxy} (Status: ${response.status})`);
          return { proxy, working: false, error: `Status ${response.status}` };
        }
      } catch (error) {
        await this.log(`✗ Proxy ${index + 1}/${totalProxies} failed: ${proxy} - ${error.message}`);
        return { proxy, working: false, error: error.message };
      }
    });

    // Wait for all validations to complete
    await Promise.allSettled(validationTasks);

    this.proxies = validProxies;
    await this.log(`🎯 Proxy validation completed: ${validProxies.length}/${totalProxies} proxies are working`);

    if (validProxies.length === 0) {
      await this.log("⚠️ No working proxies found. Will proceed with direct connections.");
    } else {
      await this.log(`✅ ${validProxies.length} proxies ready for rotation. Continuing to address processing...`);
    }
  }

  async getNextProxy() {
    if (!this.proxyIterator) return null;
    return await this.proxyIterator.getNextProxy();
  }

  async loadAddresses() {
    try {
      const addressData = await fs.readFile(config.files.addressesFile, "utf8");
      const addresses = addressData
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));

      await this.log(`Loaded ${addresses.length} addresses`);
      return addresses;
    } catch (error) {
      throw new Error(`Could not load addresses from ${config.files.addressesFile}: ${error.message}`);
    }
  }

  async loadSeedPhrases() {
    try {
      const seedData = await fs.readFile(config.files.seedPhrasesFile || "seedphrases.txt", "utf8");
      const seedPhrases = seedData
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));

      await this.log(`Loaded ${seedPhrases.length} seed phrases`);
      return seedPhrases;
    } catch (error) {
      throw new Error(
        `Could not load seed phrases from ${config.files.seedPhrasesFile || "seedphrases.txt"}: ${error.message}`
      );
    }
  }

  async loadExistingResults() {
    try {
      const existingData = [];
      const fileExists = await fs
        .access(config.files.outputFile)
        .then(() => true)
        .catch(() => false);

      if (!fileExists) {
        await this.log("No existing results file found");
        return;
      }

      await new Promise((resolve, reject) => {
        const stream = require("fs").createReadStream(config.files.outputFile);
        stream
          .pipe(csv())
          .on("data", (row) => {
            existingData.push(row);
            if (row.address || row.Address) {
              this.existingResults.add(row.address || row.Address);
            }
          })
          .on("end", resolve)
          .on("error", reject);
      });

      await this.log(`Loaded ${existingData.length} existing results`);
      this.results = existingData;
    } catch (error) {
      await this.log(`No existing results file found or error reading it: ${error.message}`);
    }
  }

  async loadExistingCexResults() {
    try {
      const existingData = [];
      const fileExists = await fs
        .access(config.files.cexOutputFile || "cex_results.csv")
        .then(() => true)
        .catch(() => false);

      if (!fileExists) {
        await this.log("No existing CEX results file found");
        return;
      }

      await new Promise((resolve, reject) => {
        const stream = require("fs").createReadStream(config.files.cexOutputFile || "cex_results.csv");
        stream
          .pipe(csv())
          .on("data", (row) => {
            existingData.push(row);
            if (row.address || row.Address) {
              this.existingCexResults.add(row.address || row.Address);
            }
          })
          .on("end", resolve)
          .on("error", reject);
      });

      await this.log(`Loaded ${existingData.length} existing CEX results`);
      this.cexResults = existingData;
    } catch (error) {
      await this.log(`No existing CEX results file found or error reading it: ${error.message}`);
    }
  }

  async loadExistingClaimResults() {
    try {
      const existingData = [];
      const fileExists = await fs
        .access(config.files.claimOutputFile || "claim_results.csv")
        .then(() => true)
        .catch(() => false);

      if (!fileExists) {
        await this.log("No existing Claim results file found");
        return;
      }

      await new Promise((resolve, reject) => {
        const stream = require("fs").createReadStream(config.files.claimOutputFile || "claim_results.csv");
        stream
          .pipe(csv())
          .on("data", (row) => {
            existingData.push(row);
            if (row.address || row.Address) {
              this.existingClaimResults.add(row.address || row.Address);
            }
          })
          .on("end", resolve)
          .on("error", reject);
      });

      await this.log(`Loaded ${existingData.length} existing Claim results`);
      this.claimResults = existingData;
    } catch (error) {
      await this.log(`No existing Claim results file found or error reading it: ${error.message}`);
    }
  }

  async loadExistingConsolidateResults() {
    try {
      const existingData = [];
      const fileExists = await fs
        .access(config.files.consolidateOutputFile || "consolidate_results.csv")
        .then(() => true)
        .catch(() => false);

      if (!fileExists) {
        await this.log("No existing Consolidate results file found");
        return;
      }

      await new Promise((resolve, reject) => {
        const stream = require("fs").createReadStream(config.files.consolidateOutputFile || "consolidate_results.csv");
        stream
          .pipe(csv())
          .on("data", (row) => {
            existingData.push(row);
            if (row.address || row.Address) {
              this.existingConsolidateResults.add(row.address || row.Address);
            }
          })
          .on("end", resolve)
          .on("error", reject);
      });

      await this.log(`Loaded ${existingData.length} existing Consolidate results`);
      this.consolidateResults = existingData;
    } catch (error) {
      await this.log(`No existing Consolidate results file found or error reading it: ${error.message}`);
    }
  }

  async connectCex(seedPhrase, retryCount = 0) {
    // Generate address from seed phrase (outside try block so it's available in catch)
    const wallet = ethers.Wallet.fromPhrase(seedPhrase);
    const address = wallet.address;

    try {
      const proxy = config.processing.proxyRotation ? await this.getNextProxy() : null;
      const axiosConfig = {
        headers: {
          ...config.headers,
          traceparent: "00-ff856923d6084d99a946af4933ab11da-3833212e8d994e83-01",
          "request-id": "|ff856923d6084d99a946af4933ab11da.3833212e8d994e83",
        },
        timeout: config.api.timeout,
      };

      if (proxy) {
        axiosConfig.httpsAgent = new HttpsProxyAgent(proxy);
      }

      // Get CEX info from config
      const cexInfo = config.cexInfo;

      const url0 = `https://airdrop.layeredge.foundation/api/register/cex?address=${address}`;
      const r0 = await axios.get(url0, axiosConfig);
      if (r0.data.cexInfo) {
        return {
          success: true,
          data: r0.data,
          proxy: proxy || "direct",
          address: address,
        };
      }
      const url = `https://airdrop.layeredge.foundation/api/message/cex?address=${address}&platform=${cexInfo.platform}&userId=${cexInfo.userId}&depositAddress=${cexInfo.depositAddress}`;

      const response = await axios.get(url, axiosConfig);
      const sign = wallet.signMessageSync(response.data.message);
      const url2 = `https://airdrop.layeredge.foundation/api/register/cex`;
      const response2 = await axios.post(
        url2,
        {
          address: address,
          signature: sign,
          chainId: 4207,
          cexInfo,
        },
        {
          ...axiosConfig,
          headers: {
            ...axiosConfig.headers,
            "Content-Type": "application/json",
          },
        }
      );
      if (response2.status === 200 && response2.data) {
        await this.log(`✓ CEX Success for ${address}: ${JSON.stringify(response2.data)}`);
        return {
          success: true,
          data: response2.data,
          proxy: proxy || "direct",
          address: address,
        };
      } else {
        throw new Error(`Invalid response status: ${response2.status}`);
      }
    } catch (error) {
      // Detailed error logging
      let errorDetails = `CEX Error for ${address}: ${error.message}`;

      if (error.response) {
        errorDetails += ` - URL: ${error.config?.url}`;
        errorDetails += ` - Status: ${error.response.status}`;
        if (error.response.data) {
          errorDetails += ` - Data: ${JSON.stringify(error.response.data)}`;
        }
      } else if (error.request) {
        errorDetails += ` - URL: ${error.config?.url}`;
        errorDetails += ` - No response received`;
      } else {
        errorDetails += ` - Setup error`;
      }

      await this.log(errorDetails);

      if (retryCount < config.api.maxRetries) {
        await this.log(
          `Retry ${retryCount + 1}/${config.api.maxRetries} for CEX ${address} in ${config.api.retryDelay}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, config.api.retryDelay));
        return this.connectCex(seedPhrase, retryCount + 1);
      } else {
        await this.log(`Max retries reached for CEX ${address}. Giving up.`);
        return {
          success: false,
          error: error.message,
          statusCode: error.response?.status,
          responseData: error.response?.data,
          address: address,
        };
      }
    }
  }

  async claimAirdrop(seedPhrase, retryCount = 0) {
    // Generate address from seed phrase
    const wallet = ethers.Wallet.fromPhrase(seedPhrase);
    const address = wallet.address;

    try {
      const proxy = config.processing.proxyRotation ? await this.getNextProxy() : null;
      const axiosConfig = {
        headers: {
          ...config.headers,
          "request-id": `|${Math.random().toString(36).substring(2, 34)}.${Math.random()
            .toString(36)
            .substring(2, 18)}`,
        },
        timeout: config.api.timeout,
      };

      if (proxy) {
        axiosConfig.httpsAgent = new HttpsProxyAgent(proxy);
      }

      // Step 1: Get TOS message
      const tosUrl = `https://airdrop.layeredge.foundation/api/message/tos?address=${address}`;
      const tosResponse = await axios.get(tosUrl, axiosConfig);

      if (tosResponse.status !== 200 || !tosResponse.data.message) {
        throw new Error(`Failed to get TOS message: ${tosResponse.status}`);
      }

      const tosMessage = tosResponse.data.message;

      // Step 2: Sign TOS message
      const tosSignature = wallet.signMessageSync(tosMessage);

      // Step 3: Get claim data
      const claimUrl = `https://airdrop.layeredge.foundation/api/claim?address=${address}&chainId=4207&signature=${tosSignature}`;
      const claimResponse = await axios.get(claimUrl, axiosConfig);

      if (claimResponse.status !== 200 || !claimResponse.data) {
        throw new Error(`Failed to get claim data: ${claimResponse.status}`);
      }

      const claimData = claimResponse.data;

      // Step 4: Prepare claim payload
      const amount = (parseFloat(claimData.allocation) * 1e18).toString(); // Convert to wei
      const claimPayload = {
        amount: amount,
        proof: claimData.proof,
        signature: claimData.signature,
        userAddress: address,
      };

      // Step 5: Sign the claim payload
      const claimMessage = JSON.stringify(claimPayload);
      const authoritySignature = wallet.signMessageSync(claimMessage);

      // Step 6: Final claim API call
      const finalClaimPayload = {
        ...claimPayload,
        authority: authoritySignature,
      };

      const finalClaimUrl = `https://airdrop.layeredge.foundation/api/paymaster/claim`;
      const finalResponse = await axios.post(finalClaimUrl, finalClaimPayload, {
        ...axiosConfig,
        headers: {
          ...axiosConfig.headers,
          "content-type": "application/json",
        },
      });

      if (finalResponse.status === 200) {
        await this.log(`🎉 Claim SUCCESS for ${address}: ${JSON.stringify(finalResponse.data)}`);
        return {
          success: true,
          data: finalResponse.data,
          proxy: proxy || "direct",
          address: address,
          allocation: claimData.allocation,
        };
      } else {
        throw new Error(`Final claim failed: ${finalResponse.status}`);
      }
    } catch (error) {
      // Detailed error logging
      let errorDetails = `Claim Error for ${address}: ${error.message}`;
      // if ("execution reverted" in error.message) {
      //   errorDetails += ` - Execution reverted`;
      //   return {
      //     success: false,
      //     error: error.message,
      //     statusCode: 400,
      //     responseData: error.response?.data,
      //     address: address,
      //   };
      // }
      if (error.response) {
        errorDetails += ` - URL: ${error.config?.url}`;
        errorDetails += ` - Status: ${error.response.status}`;
        if (error.response.data) {
          errorDetails += ` - Data: ${JSON.stringify(error.response.data)}`;
        }
      } else if (error.request) {
        errorDetails += ` - URL: ${error.config?.url}`;
        errorDetails += ` - No response received`;
      } else {
        errorDetails += ` - Setup error`;
      }

      await this.log(errorDetails);
      if (error.response.status == 404) {
        return {
          success: false,
          error: error.message,
          statusCode: error.response?.status,
          responseData: error.response?.data,
          address: address,
        };
      }
      if (retryCount < config.api.maxRetries) {
        await this.log(
          `Retry ${retryCount + 1}/${config.api.maxRetries} for Claim ${address} in ${config.api.retryDelay}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, config.api.retryDelay));
        return this.claimAirdrop(seedPhrase, retryCount + 1);
      } else {
        await this.log(`Max retries reached for Claim ${address}. Giving up.`);
        return {
          success: false,
          error: error.message,
          statusCode: error.response?.status,
          responseData: error.response?.data,
          address: address,
        };
      }
    }
  }

  async consolidateETH(seedPhrase, targetAddress, retryCount = 0) {
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
        await this.log(`💰 Using proxy for RPC: ${proxy}`);
      } else {
        provider = new ethers.JsonRpcProvider("https://rpc.layeredge.io");
        await this.log(`💰 Using direct RPC connection`);
      }

      const walletWithProvider = wallet.connect(provider);

      await this.log(`💰 Starting ETH consolidation from ${fromAddress} to ${targetAddress}`);

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
            message: "No balance to consolidate",
            balance: "0",
            nonce: nonce,
          },
          address: fromAddress,
          targetAddress: targetAddress,
        };
      }

      await this.log(`💰 Found ${balanceInEth} ETH in ${fromAddress}`);

      // Step 2: Get nonce
      const nonce = await provider.getTransactionCount(fromAddress);
      await this.log(`🔢 Current nonce for ${fromAddress}: ${nonce}`);

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
          address: fromAddress,
          targetAddress: targetAddress,
        };
      }

      const amountInEth = ethers.formatEther(amountToSend);
      await this.log(`📤 Sending ${amountInEth} ETH from ${fromAddress} to ${targetAddress} (nonce: ${nonce})`);

      // Step 5: Create and send transaction
      const tx = {
        to: targetAddress,
        value: amountToSend,
        gasLimit: estimatedGas,
        gasPrice: gasPrice.gasPrice,
        nonce: nonce,
      };

      const txResponse = await walletWithProvider.sendTransaction(tx);
      await this.log(`⏳ Transaction sent: ${txResponse.hash} (nonce: ${nonce})`);

      // Step 5: Wait for confirmation
      const receipt = await txResponse.wait();

      if (receipt.status === 1) {
        await this.log(
          `✅ ETH Consolidation SUCCESS: ${amountInEth} ETH sent from ${fromAddress} to ${targetAddress} (nonce: ${nonce})`
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
          address: fromAddress,
          targetAddress: targetAddress,
        };
      } else {
        throw new Error(`Transaction failed with status: ${receipt.status}`);
      }
    } catch (error) {
      // Error logging
      let errorDetails = `Consolidate Error for ${fromAddress}: ${error.message}`;

      if (error.code) {
        errorDetails += ` - Code: ${error.code}`;
      }
      if (error.reason) {
        errorDetails += ` - Reason: ${error.reason}`;
      }

      await this.log(errorDetails);

      if (retryCount < config.api.maxRetries) {
        await this.log(
          `Retry ${retryCount + 1}/${config.api.maxRetries} for Consolidate ${fromAddress} in ${
            config.api.retryDelay
          }ms`
        );
        await new Promise((resolve) => setTimeout(resolve, config.api.retryDelay));
        return this.consolidateETH(seedPhrase, targetAddress, retryCount + 1);
      } else {
        await this.log(`Max retries reached for Consolidate ${fromAddress}. Giving up.`);
        return {
          success: false,
          error: error.message,
          code: error.code,
          reason: error.reason,
          address: fromAddress,
          targetAddress: targetAddress,
        };
      }
    }
  }

  async fetchAllocation(address, retryCount = 0) {
    try {
      const proxy = config.processing.proxyRotation ? await this.getNextProxy() : null;
      const axiosConfig = {
        headers: {
          ...config.headers,
        },
        timeout: config.api.timeout,
      };

      if (proxy) {
        axiosConfig.httpsAgent = new HttpsProxyAgent(proxy);
      }

      const url = `${config.api.baseUrl}?address=${address}`;
      const response = await axios.get(url, axiosConfig);

      if (response.status === 200 && response.data) {
        await this.log(`✓ Success for ${address}: ${JSON.stringify(response.data)}`);
        return {
          success: true,
          data: response.data,
          proxy: proxy || "direct",
        };
      } else {
        throw new Error(`Invalid response status: ${response.status}`);
      }
    } catch (error) {
      // Detailed error logging
      let errorDetails = `Allocation Error for ${address}: ${error.message}`;

      if (error.response) {
        errorDetails += ` - URL: ${error.config?.url}`;
        errorDetails += ` - Status: ${error.response.status}`;
        if (error.response.data) {
          errorDetails += ` - Data: ${JSON.stringify(error.response.data)}`;
        }
      } else if (error.request) {
        errorDetails += ` - URL: ${error.config?.url}`;
        errorDetails += ` - No response received`;
      } else {
        errorDetails += ` - Setup error`;
      }

      await this.log(errorDetails);

      if (retryCount < config.api.maxRetries) {
        await this.log(`Retry ${retryCount + 1}/${config.api.maxRetries} for ${address} in ${config.api.retryDelay}ms`);
        await new Promise((resolve) => setTimeout(resolve, config.api.retryDelay));
        return this.fetchAllocation(address, retryCount + 1);
      } else {
        await this.log(`Max retries reached for ${address}. Giving up.`);
        return {
          success: false,
          error: error.message,
          statusCode: error.response?.status,
          responseData: error.response?.data,
        };
      }
    }
  }

  async processSeedPhrase(seedPhrase, index, total) {
    // Generate address from seed phrase to check if already processed
    const wallet = ethers.Wallet.fromPhrase(seedPhrase);
    const address = wallet.address;

    // Check if this address was already processed in CEX results
    if (config.processing.skipExisting && this.existingCexResults.has(address)) {
      await this.log(`Skipping ${address} (${index + 1}/${total}) - already processed in CEX`);
      return null;
    }

    await this.log(`Processing seed phrase ${index + 1}/${total} -> ${address}`);

    // Add delay between requests to avoid rate limiting
    if (config.processing.delayBetweenRequests && index > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.processing.delayBetweenRequests));
    }

    const result = await this.connectCex(seedPhrase);

    if (result.success) {
      const csvRow = {
        address: result.address || address,
        data: JSON.stringify(result.data),
      };

      this.cexResults = this.cexResults || [];
      this.cexResults.push(csvRow);
      await this.log(`✓ CEX Success for ${result.address || address}: ${JSON.stringify(result.data)}`);

      // Save result immediately after processing
      await this.saveCexResultsImmediate();

      return csvRow;
    } else {
      const csvRow = {
        address: result.address || address,
        data: JSON.stringify({ error: result.error }),
      };

      this.cexResults = this.cexResults || [];
      this.cexResults.push(csvRow);
      await this.log(`✗ CEX Failed for ${result.address || address}: ${result.error}`);

      // Save result immediately after processing
      await this.saveCexResultsImmediate();

      return csvRow;
    }
  }

  async saveCexResultsImmediate() {
    try {
      const csvWriter = createCsvWriter({
        path: config.files.cexOutputFile || "cex_results.csv",
        header: [
          { id: "address", title: "Address" },
          { id: "data", title: "Data" },
        ],
      });

      // Write all CEX results
      await csvWriter.writeRecords(this.cexResults || []);

      // Log only for significant milestones to avoid spam
      if ((this.cexResults?.length || 0) % 10 === 0) {
        await this.log(
          `💾 CEX Results saved: ${this.cexResults?.length || 0} total records in ${
            config.files.cexOutputFile || "cex_results.csv"
          }`
        );
      }
    } catch (error) {
      await this.log(`❌ Error saving CEX results: ${error.message}`);
    }
  }

  async processClaimSeedPhrase(seedPhrase, index, total) {
    // Generate address from seed phrase to check if already processed
    const wallet = ethers.Wallet.fromPhrase(seedPhrase);
    const address = wallet.address;

    // Check if this address was already processed in Claim results
    if (config.processing.skipExisting && this.existingClaimResults.has(address)) {
      await this.log(`Skipping ${address} (${index + 1}/${total}) - already processed in Claim`);
      return null;
    }

    await this.log(`Processing claim seed phrase ${index + 1}/${total} -> ${address}`);

    // Add delay between requests to avoid rate limiting
    if (config.processing.delayBetweenRequests && index > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.processing.delayBetweenRequests));
    }

    const result = await this.claimAirdrop(seedPhrase);

    if (result.success) {
      const csvRow = {
        address: result.address || address,
        data: JSON.stringify(result.data),
      };

      this.claimResults = this.claimResults || [];
      this.claimResults.push(csvRow);
      await this.log(`🎉 Claim Success for ${result.address || address}: allocation=${result.allocation}`);

      // Save result immediately after processing
      await this.saveClaimResultsImmediate();

      return csvRow;
    } else {
      const csvRow = {
        address: result.address || address,
        data: JSON.stringify({ error: result.error }),
      };

      this.claimResults = this.claimResults || [];
      this.claimResults.push(csvRow);
      await this.log(`❌ Claim Failed for ${result.address || address}: ${result.error}`);

      // Save result immediately after processing
      await this.saveClaimResultsImmediate();

      return csvRow;
    }
  }

  async saveClaimResultsImmediate() {
    try {
      const csvWriter = createCsvWriter({
        path: config.files.claimOutputFile || "claim_results.csv",
        header: [
          { id: "address", title: "Address" },
          { id: "data", title: "Data" },
        ],
      });

      // Write all Claim results
      await csvWriter.writeRecords(this.claimResults || []);

      // Log only for significant milestones to avoid spam
      if ((this.claimResults?.length || 0) % 10 === 0) {
        await this.log(
          `💾 Claim Results saved: ${this.claimResults?.length || 0} total records in ${
            config.files.claimOutputFile || "claim_results.csv"
          }`
        );
      }
    } catch (error) {
      await this.log(`❌ Error saving Claim results: ${error.message}`);
    }
  }

  async processConsolidateSeedPhrase(seedPhrase, targetAddress, index, total) {
    // Generate address from seed phrase to check if already processed
    const wallet = ethers.Wallet.fromPhrase(seedPhrase);
    const address = wallet.address;

    // Check if this address was already processed in Consolidate results
    if (config.processing.skipExisting && this.existingConsolidateResults.has(address)) {
      await this.log(`Skipping ${address} (${index + 1}/${total}) - already processed in Consolidate`);
      return null;
    }

    await this.log(`Processing consolidate seed phrase ${index + 1}/${total} -> ${address}`);

    // Add delay between requests to avoid rate limiting
    if (config.processing.delayBetweenRequests && index > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.processing.delayBetweenRequests));
    }

    const result = await this.consolidateETH(seedPhrase, targetAddress);

    if (result.success) {
      const csvRow = {
        address: result.address || address,
        data: JSON.stringify(result.data),
      };

      this.consolidateResults = this.consolidateResults || [];
      this.consolidateResults.push(csvRow);

      if (result.data.amount) {
        await this.log(`💰 Consolidate Success for ${result.address || address}: ${result.data.amount} ETH sent`);
      } else {
        await this.log(`✅ Consolidate Success for ${result.address || address}: ${result.data.message}`);
      }

      // Save result immediately after processing
      await this.saveConsolidateResultsImmediate();

      return csvRow;
    } else {
      const csvRow = {
        address: result.address || address,
        data: JSON.stringify({ error: result.error }),
      };

      this.consolidateResults = this.consolidateResults || [];
      this.consolidateResults.push(csvRow);
      await this.log(`❌ Consolidate Failed for ${result.address || address}: ${result.error}`);

      // Save result immediately after processing
      await this.saveConsolidateResultsImmediate();

      return csvRow;
    }
  }

  async saveConsolidateResultsImmediate() {
    try {
      const csvWriter = createCsvWriter({
        path: config.files.consolidateOutputFile || "consolidate_results.csv",
        header: [
          { id: "address", title: "Address" },
          { id: "data", title: "Data" },
        ],
      });

      // Write all Consolidate results
      await csvWriter.writeRecords(this.consolidateResults || []);

      // Log only for significant milestones to avoid spam
      if ((this.consolidateResults?.length || 0) % 10 === 0) {
        await this.log(
          `💾 Consolidate Results saved: ${this.consolidateResults?.length || 0} total records in ${
            config.files.consolidateOutputFile || "consolidate_results.csv"
          }`
        );
      }
    } catch (error) {
      await this.log(`❌ Error saving Consolidate results: ${error.message}`);
    }
  }

  async processAddress(address, index, total) {
    if (config.processing.skipExisting && this.existingResults.has(address)) {
      await this.log(`Skipping ${address} (${index + 1}/${total}) - already processed`);
      return null;
    }

    await this.log(`Processing ${address} (${index + 1}/${total})`);

    // Add delay between requests to avoid rate limiting
    if (config.processing.delayBetweenRequests && index > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.processing.delayBetweenRequests));
    }

    const result = await this.fetchAllocation(address);

    if (result.success) {
      const csvRow = {
        address: address,
        allocation: result.data.allocation || "",
        initAllocation: result.data.initAllocation || "",
        proof: JSON.stringify(result.data.proof || []),
        details: JSON.stringify(result.data.details || {}),
        timestamp: new Date().toISOString(),
        proxy: result.proxy,
      };

      this.results.push(csvRow);
      await this.log(
        `✓ Success for ${address}: allocation=${csvRow.allocation}, initAllocation=${csvRow.initAllocation}`
      );

      // Save result immediately after processing
      await this.saveResultsImmediate();

      return csvRow;
    } else {
      const csvRow = {
        address: address,
        allocation: "",
        initAllocation: "",
        proof: "",
        details: "",
        timestamp: new Date().toISOString(),
        proxy: "",
        error: result.error,
        statusCode: result.statusCode || "",
        responseData: result.responseData ? JSON.stringify(result.responseData) : "",
      };

      this.results.push(csvRow);
      await this.log(`✗ Failed for ${address}: ${result.error} (Status: ${result.statusCode})`);

      // Save result immediately after processing
      await this.saveResultsImmediate();

      return csvRow;
    }
  }

  async saveResultsImmediate() {
    try {
      const csvWriter = createCsvWriter({
        path: config.files.outputFile,
        header: [
          { id: "address", title: "Address" },
          { id: "allocation", title: "Allocation" },
          { id: "initAllocation", title: "InitAllocation" },
          { id: "proof", title: "Proof" },
          { id: "details", title: "Details" },
          { id: "timestamp", title: "Timestamp" },
          { id: "proxy", title: "Proxy" },
          { id: "error", title: "Error" },
          { id: "statusCode", title: "StatusCode" },
          { id: "responseData", title: "ResponseData" },
        ],
      });

      // Write all results (this will overwrite the file with all current results)
      await csvWriter.writeRecords(this.results);

      // Log only for significant milestones to avoid spam
      if (this.results.length % 10 === 0) {
        await this.log(`💾 Results saved: ${this.results.length} total records in ${config.files.outputFile}`);
      }
    } catch (error) {
      await this.log(`❌ Error saving results: ${error.message}`);
    }
  }

  async saveResults() {
    const csvWriter = createCsvWriter({
      path: config.files.outputFile,
      header: [
        { id: "address", title: "Address" },
        { id: "allocation", title: "Allocation" },
        { id: "initAllocation", title: "InitAllocation" },
        { id: "proof", title: "Proof" },
        { id: "details", title: "Details" },
        { id: "timestamp", title: "Timestamp" },
        { id: "proxy", title: "Proxy" },
        { id: "error", title: "Error" },
        { id: "statusCode", title: "StatusCode" },
        { id: "responseData", title: "ResponseData" },
      ],
    });

    await csvWriter.writeRecords(this.results);
    await this.log(`📊 Final results saved to ${config.files.outputFile} (${this.results.length} total records)`);
  }

  async processBatch(addresses, batchIndex) {
    const batchSize = addresses.length;
    const startTime = Date.now();
    let successCount = 0;
    let errorCount = 0;

    await this.log(`🔄 Processing batch ${batchIndex + 1} with ${batchSize} addresses...`);

    // Create tasks for all addresses in this batch
    const tasks = addresses.map((address, index) => {
      return () => this.processAddress(address, index, batchSize);
    });

    // Process all tasks using async pool (max 100 concurrent)
    const results = await Promise.allSettled(tasks.map((task) => this.pool.add(task)));

    // Count results
    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value && !result.value.error) {
        successCount++;
      } else {
        errorCount++;
        if (result.status === "rejected") {
          this.log(`💥 Task failed for ${addresses[index]}: ${result.reason}`);
        }
      }
    });

    const batchTime = Math.round((Date.now() - startTime) / 1000);
    const batchRate = batchSize / batchTime;

    await this.log(
      `✅ Batch ${
        batchIndex + 1
      } completed: ${successCount}/${batchSize} successful in ${batchTime}s (${batchRate.toFixed(2)} addr/s)`
    );

    // Results are already saved immediately after each address processing
    await this.log(`💾 All results from batch ${batchIndex + 1} are already saved to CSV`);

    return { successCount, errorCount, batchTime };
  }

  async processAddresses(addresses) {
    const total = addresses.length;
    const startTime = Date.now();
    let totalSuccess = 0;
    let totalErrors = 0;

    await this.log(`🚀 Starting background processing of ${total} addresses in batches of ${this.batchSize}...`);

    // Split addresses into batches
    const batches = [];
    for (let i = 0; i < addresses.length; i += this.batchSize) {
      batches.push(addresses.slice(i, i + this.batchSize));
    }

    await this.log(`📦 Created ${batches.length} batches for processing`);

    // Process each batch
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchResult = await this.processBatch(batch, i);

      totalSuccess += batchResult.successCount;
      totalErrors += batchResult.errorCount;

      const processed = (i + 1) * this.batchSize;
      const remaining = Math.max(0, total - processed);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const rate = processed / elapsed;
      const eta = remaining > 0 ? Math.round(remaining / rate) : 0;

      await this.log(
        `📊 Overall Progress: ${Math.min(processed, total)}/${total} (${Math.round(
          (Math.min(processed, total) / total) * 100
        )}%) | ✅ ${totalSuccess} | ❌ ${totalErrors} | ⏱️ ${elapsed}s | ETA: ${eta}s`
      );

      // Delay between batches to avoid overwhelming the server
      if (i < batches.length - 1) {
        await this.log(`⏳ Waiting ${config.processing.delayBetweenBatches}ms before next batch...`);
        await new Promise((resolve) => setTimeout(resolve, config.processing.delayBetweenBatches));
      }
    }

    // Final summary
    const totalTime = Math.round((Date.now() - startTime) / 1000);
    const avgRate = total / totalTime;

    await this.log("=".repeat(60));
    await this.log("📈 FINAL PROCESSING SUMMARY:");
    await this.log(`   • Total processed: ${total}`);
    await this.log(`   • Successful: ${totalSuccess} (${Math.round((totalSuccess / total) * 100)}%)`);
    await this.log(`   • Failed: ${totalErrors} (${Math.round((totalErrors / total) * 100)}%)`);
    await this.log(`   • Total time: ${totalTime}s`);
    await this.log(`   • Average rate: ${avgRate.toFixed(2)} addresses/second`);
    await this.log(`   • Batches processed: ${batches.length}`);
    await this.log(`   • Max concurrent: ${config.processing.maxConcurrent} addresses`);
    await this.log("=".repeat(60));
  }

  async runCexBackground() {
    if (this.isRunning) {
      await this.log("⚠️ Background process is already running!");
      return;
    }

    this.isRunning = true;

    try {
      await this.log("🏦 Starting LayerEdge CEX Connector in BACKGROUND mode...");
      await this.log("=".repeat(60));

      // Step 1: Load proxies
      await this.log("📡 Step 1: Loading proxies...");
      await this.loadProxies();

      // Step 2: Load existing CEX results
      await this.log("📄 Step 2: Loading existing CEX results...");
      await this.loadExistingCexResults();

      // Step 3: Load seed phrases
      await this.log("🌱 Step 3: Loading seed phrases...");
      const seedPhrases = await this.loadSeedPhrases();

      if (seedPhrases.length === 0) {
        throw new Error("No seed phrases to process");
      }

      // Step 4: Filter seed phrases based on existing results
      const seedPhrasesToProcess = [];
      for (const seedPhrase of seedPhrases) {
        const wallet = ethers.Wallet.fromPhrase(seedPhrase);
        const address = wallet.address;

        if (config.processing.skipExisting && this.existingCexResults.has(address)) {
          // Skip this seed phrase as address already processed
          continue;
        }
        seedPhrasesToProcess.push(seedPhrase);
      }

      // Step 5: Show processing summary
      await this.log("=".repeat(60));
      await this.log("🏦 CEX PROCESSING SUMMARY:");
      await this.log(`   • Total seed phrases: ${seedPhrases.length}`);
      await this.log(`   • To process: ${seedPhrasesToProcess.length}`);
      await this.log(`   • Already completed: ${seedPhrases.length - seedPhrasesToProcess.length}`);
      await this.log(`   • Working proxies: ${this.proxies.length}`);
      await this.log(`   • Batch size: ${this.batchSize} seed phrases`);
      await this.log(`   • Max concurrent per batch: ${config.processing.maxConcurrent} seed phrases`);
      await this.log(`   • Max retries per seed phrase: ${config.api.maxRetries}`);
      await this.log(`   • Proxy rotation: ${config.processing.proxyRotation ? "Enabled" : "Disabled"}`);
      await this.log(`   • Skip existing: ${config.processing.skipExisting ? "Enabled" : "Disabled"}`);
      await this.log(`   • Output file: ${config.files.cexOutputFile || "cex_results.csv"}`);
      await this.log("=".repeat(60));

      if (seedPhrasesToProcess.length === 0) {
        await this.log("✅ All seed phrases have already been processed successfully!");
        this.isRunning = false;
        return;
      }

      // Step 6: Start CEX processing
      await this.log("🔄 Starting CEX seed phrase processing...");
      await this.processSeedPhrases(seedPhrasesToProcess);

      await this.log("=".repeat(60));
      await this.log("🎉 CEX processing completed successfully!");
      await this.log(`📊 Final results saved to: ${config.files.cexOutputFile || "cex_results.csv"}`);
      await this.log(`📝 Detailed logs saved to: ${config.files.logFile}`);
    } catch (error) {
      await this.log(`💥 Fatal error in CEX background process: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  async processSeedPhrases(seedPhrases) {
    const total = seedPhrases.length;
    const startTime = Date.now();
    let totalSuccess = 0;
    let totalErrors = 0;

    await this.log(`🚀 Starting background processing of ${total} seed phrases in batches of ${this.batchSize}...`);

    // Split seed phrases into batches
    const batches = [];
    for (let i = 0; i < seedPhrases.length; i += this.batchSize) {
      batches.push(seedPhrases.slice(i, i + this.batchSize));
    }

    await this.log(`📦 Created ${batches.length} batches for processing`);

    // Process each batch
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchResult = await this.processSeedPhraseBatch(batch, i);

      totalSuccess += batchResult.successCount;
      totalErrors += batchResult.errorCount;

      const processed = (i + 1) * this.batchSize;
      const remaining = Math.max(0, total - processed);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const rate = processed / elapsed;
      const eta = remaining > 0 ? Math.round(remaining / rate) : 0;

      await this.log(
        `📊 CEX Progress: ${Math.min(processed, total)}/${total} (${Math.round(
          (Math.min(processed, total) / total) * 100
        )}%) | ✅ ${totalSuccess} | ❌ ${totalErrors} | ⏱️ ${elapsed}s | ETA: ${eta}s`
      );

      // Delay between batches
      if (i < batches.length - 1) {
        await this.log(`⏳ Waiting ${config.processing.delayBetweenBatches}ms before next batch...`);
        await new Promise((resolve) => setTimeout(resolve, config.processing.delayBetweenBatches));
      }
    }

    // Final summary
    const totalTime = Math.round((Date.now() - startTime) / 1000);
    const avgRate = total / totalTime;

    await this.log("=".repeat(60));
    await this.log("🏦 FINAL CEX PROCESSING SUMMARY:");
    await this.log(`   • Total processed: ${total}`);
    await this.log(`   • Successful: ${totalSuccess} (${Math.round((totalSuccess / total) * 100)}%)`);
    await this.log(`   • Failed: ${totalErrors} (${Math.round((totalErrors / total) * 100)}%)`);
    await this.log(`   • Total time: ${totalTime}s`);
    await this.log(`   • Average rate: ${avgRate.toFixed(2)} seed phrases/second`);
    await this.log(`   • Batches processed: ${batches.length}`);
    await this.log("=".repeat(60));
  }

  async processSeedPhraseBatch(seedPhrases, batchIndex) {
    const batchSize = seedPhrases.length;
    const startTime = Date.now();
    let successCount = 0;
    let errorCount = 0;

    await this.log(`🔄 Processing CEX batch ${batchIndex + 1} with ${batchSize} seed phrases...`);

    // Create tasks for all seed phrases in this batch
    const tasks = seedPhrases.map((seedPhrase, index) => {
      return () => this.processSeedPhrase(seedPhrase, index, batchSize);
    });

    // Process all tasks using async pool
    const results = await Promise.allSettled(tasks.map((task) => this.pool.add(task)));

    // Count results
    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value && !result.value.error) {
        successCount++;
      } else {
        errorCount++;
        if (result.status === "rejected") {
          this.log(`💥 CEX Task failed for seed phrase ${index + 1}: ${result.reason}`);
        }
      }
    });

    const batchTime = Math.round((Date.now() - startTime) / 1000);
    const batchRate = batchSize / batchTime;

    await this.log(
      `✅ CEX Batch ${
        batchIndex + 1
      } completed: ${successCount}/${batchSize} successful in ${batchTime}s (${batchRate.toFixed(2)} phrases/s)`
    );

    return { successCount, errorCount, batchTime };
  }

  async runClaimBackground() {
    if (this.isRunning) {
      await this.log("⚠️ Background process is already running!");
      return;
    }

    this.isRunning = true;

    try {
      await this.log("🎯 Starting LayerEdge Claim Processor in BACKGROUND mode...");
      await this.log("=".repeat(60));

      // Step 1: Load proxies
      await this.log("📡 Step 1: Loading proxies...");
      await this.loadProxies();

      // Step 2: Load existing Claim results
      await this.log("📄 Step 2: Loading existing Claim results...");
      await this.loadExistingClaimResults();

      // Step 3: Load seed phrases
      await this.log("🌱 Step 3: Loading seed phrases...");
      const seedPhrases = await this.loadSeedPhrases();

      if (seedPhrases.length === 0) {
        throw new Error("No seed phrases to process");
      }

      // Step 4: Filter seed phrases based on existing results
      const seedPhrasesToProcess = [];
      for (const seedPhrase of seedPhrases) {
        const wallet = ethers.Wallet.fromPhrase(seedPhrase);
        const address = wallet.address;

        if (config.processing.skipExisting && this.existingClaimResults.has(address)) {
          // Skip this seed phrase as address already processed
          continue;
        }
        seedPhrasesToProcess.push(seedPhrase);
      }

      // Step 5: Show processing summary
      await this.log("=".repeat(60));
      await this.log("🎯 CLAIM PROCESSING SUMMARY:");
      await this.log(`   • Total seed phrases: ${seedPhrases.length}`);
      await this.log(`   • To process: ${seedPhrasesToProcess.length}`);
      await this.log(`   • Already completed: ${seedPhrases.length - seedPhrasesToProcess.length}`);
      await this.log(`   • Working proxies: ${this.proxies.length}`);
      await this.log(`   • Batch size: ${this.batchSize} seed phrases`);
      await this.log(`   • Max concurrent per batch: ${config.processing.maxConcurrent} seed phrases`);
      await this.log(`   • Max retries per seed phrase: ${config.api.maxRetries}`);
      await this.log(`   • Proxy rotation: ${config.processing.proxyRotation ? "Enabled" : "Disabled"}`);
      await this.log(`   • Skip existing: ${config.processing.skipExisting ? "Enabled" : "Disabled"}`);
      await this.log(`   • Output file: ${config.files.claimOutputFile || "claim_results.csv"}`);
      await this.log("=".repeat(60));

      if (seedPhrasesToProcess.length === 0) {
        await this.log("✅ All seed phrases have already been processed successfully!");
        this.isRunning = false;
        return;
      }

      // Step 6: Start Claim processing
      await this.log("🔄 Starting Claim seed phrase processing...");
      await this.processClaimSeedPhrases(seedPhrasesToProcess);

      await this.log("=".repeat(60));
      await this.log("🎉 Claim processing completed successfully!");
      await this.log(`📊 Final results saved to: ${config.files.claimOutputFile || "claim_results.csv"}`);
      await this.log(`📝 Detailed logs saved to: ${config.files.logFile}`);
    } catch (error) {
      await this.log(`💥 Fatal error in Claim background process: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  async processClaimSeedPhrases(seedPhrases) {
    const total = seedPhrases.length;
    const startTime = Date.now();
    let totalSuccess = 0;
    let totalErrors = 0;

    await this.log(
      `🚀 Starting background processing of ${total} claim seed phrases in batches of ${this.batchSize}...`
    );

    // Split seed phrases into batches
    const batches = [];
    for (let i = 0; i < seedPhrases.length; i += this.batchSize) {
      batches.push(seedPhrases.slice(i, i + this.batchSize));
    }

    await this.log(`📦 Created ${batches.length} batches for processing`);

    // Process each batch
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchResult = await this.processClaimSeedPhraseBatch(batch, i);

      totalSuccess += batchResult.successCount;
      totalErrors += batchResult.errorCount;

      const processed = (i + 1) * this.batchSize;
      const remaining = Math.max(0, total - processed);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const rate = processed / elapsed;
      const eta = remaining > 0 ? Math.round(remaining / rate) : 0;

      await this.log(
        `📊 Claim Progress: ${Math.min(processed, total)}/${total} (${Math.round(
          (Math.min(processed, total) / total) * 100
        )}%) | ✅ ${totalSuccess} | ❌ ${totalErrors} | ⏱️ ${elapsed}s | ETA: ${eta}s`
      );

      // Delay between batches
      if (i < batches.length - 1) {
        await this.log(`⏳ Waiting ${config.processing.delayBetweenBatches}ms before next batch...`);
        await new Promise((resolve) => setTimeout(resolve, config.processing.delayBetweenBatches));
      }
    }

    // Final summary
    const totalTime = Math.round((Date.now() - startTime) / 1000);
    const avgRate = total / totalTime;

    await this.log("=".repeat(60));
    await this.log("🎯 FINAL CLAIM PROCESSING SUMMARY:");
    await this.log(`   • Total processed: ${total}`);
    await this.log(`   • Successful: ${totalSuccess} (${Math.round((totalSuccess / total) * 100)}%)`);
    await this.log(`   • Failed: ${totalErrors} (${Math.round((totalErrors / total) * 100)}%)`);
    await this.log(`   • Total time: ${totalTime}s`);
    await this.log(`   • Average rate: ${avgRate.toFixed(2)} seed phrases/second`);
    await this.log(`   • Batches processed: ${batches.length}`);
    await this.log("=".repeat(60));
  }

  async processClaimSeedPhraseBatch(seedPhrases, batchIndex) {
    const batchSize = seedPhrases.length;
    const startTime = Date.now();
    let successCount = 0;
    let errorCount = 0;

    await this.log(`🔄 Processing Claim batch ${batchIndex + 1} with ${batchSize} seed phrases...`);

    // Create tasks for all seed phrases in this batch
    const tasks = seedPhrases.map((seedPhrase, index) => {
      return () => this.processClaimSeedPhrase(seedPhrase, index, batchSize);
    });

    // Process all tasks using async pool
    const results = await Promise.allSettled(tasks.map((task) => this.pool.add(task)));

    // Count results
    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value && !result.value.error) {
        successCount++;
      } else {
        errorCount++;
        if (result.status === "rejected") {
          this.log(`💥 Claim Task failed for seed phrase ${index + 1}: ${result.reason}`);
        }
      }
    });

    const batchTime = Math.round((Date.now() - startTime) / 1000);
    const batchRate = batchSize / batchTime;

    await this.log(
      `✅ Claim Batch ${
        batchIndex + 1
      } completed: ${successCount}/${batchSize} successful in ${batchTime}s (${batchRate.toFixed(2)} phrases/s)`
    );

    return { successCount, errorCount, batchTime };
  }

  async runBackground() {
    if (this.isRunning) {
      await this.log("⚠️ Background process is already running!");
      return;
    }

    this.isRunning = true;

    try {
      await this.log("🌙 Starting LayerEdge Allocation Checker in BACKGROUND mode...");
      await this.log("=".repeat(60));

      // Step 1: Load proxies (validation happens on-demand)
      await this.log("📡 Step 1: Loading proxies...");
      await this.loadProxies();

      // Step 2: Load existing results
      await this.log("📄 Step 2: Loading existing results...");
      await this.loadExistingResults();

      // Step 3: Load addresses
      await this.log("📋 Step 3: Loading addresses...");
      const addresses = await this.loadAddresses();

      if (addresses.length === 0) {
        throw new Error("No addresses to process");
      }

      // Step 4: Filter addresses
      const addressesToProcess = config.processing.skipExisting
        ? addresses.filter((addr) => !this.existingResults.has(addr))
        : addresses;

      await this.log(`📊 Found ${addresses.length} total addresses`);
      await this.log(
        `📊 Processing ${addressesToProcess.length} addresses (${
          addresses.length - addressesToProcess.length
        } already completed)`
      );

      if (addressesToProcess.length === 0) {
        await this.log("✅ All addresses have already been processed successfully!");
        this.isRunning = false;
        return;
      }

      // Step 5: Show processing summary
      await this.log("=".repeat(60));
      await this.log("📈 BACKGROUND PROCESSING SUMMARY:");
      await this.log(`   • Total addresses: ${addresses.length}`);
      await this.log(`   • To process: ${addressesToProcess.length}`);
      await this.log(`   • Already completed: ${addresses.length - addressesToProcess.length}`);
      await this.log(`   • Working proxies: ${this.proxies.length}`);
      await this.log(`   • Batch size: ${this.batchSize} addresses`);
      await this.log(`   • Max concurrent per batch: ${config.processing.maxConcurrent} addresses`);
      await this.log(`   • Max retries per address: ${config.api.maxRetries}`);
      await this.log(`   • Proxy rotation: ${config.processing.proxyRotation ? "Enabled" : "Disabled"}`);
      await this.log("=".repeat(60));

      // Step 6: Start background processing
      await this.log("🔄 Starting background address processing...");
      await this.processAddresses(addressesToProcess);

      await this.log("=".repeat(60));
      await this.log("🎉 Background processing completed successfully!");
      await this.log(`📊 Final results saved to: ${config.files.outputFile}`);
      await this.log(`📝 Detailed logs saved to: ${config.files.logFile}`);
    } catch (error) {
      await this.log(`💥 Fatal error in background process: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  async runConsolidateBackground() {
    if (this.isRunning) {
      await this.log("⚠️ Background process is already running!");
      return;
    }

    this.isRunning = true;

    try {
      await this.log("💰 Starting LayerEdge ETH Consolidate Processor in BACKGROUND mode...");
      await this.log("=".repeat(60));

      // Step 1: Load proxies (not needed for blockchain operations but keep for consistency)
      await this.log("📡 Step 1: Loading proxies...");
      await this.loadProxies();

      // Step 2: Load existing Consolidate results
      await this.log("📄 Step 2: Loading existing Consolidate results...");
      await this.loadExistingConsolidateResults();

      // Step 3: Load seed phrases
      await this.log("🌱 Step 3: Loading seed phrases...");
      const seedPhrases = await this.loadSeedPhrases();

      if (seedPhrases.length === 0) {
        throw new Error("No seed phrases to process");
      }

      // Step 4: Get target address from config
      const targetAddress = config.consolidate.targetAddress;
      if (!targetAddress) {
        throw new Error("Target address not configured in config.consolidate.targetAddress");
      }

      await this.log(`🎯 Target address: ${targetAddress}`);

      // Step 5: Filter seed phrases based on existing results
      const seedPhrasesToProcess = [];
      for (const seedPhrase of seedPhrases) {
        const wallet = ethers.Wallet.fromPhrase(seedPhrase);
        const address = wallet.address;

        if (config.processing.skipExisting && this.existingConsolidateResults.has(address)) {
          // Skip this seed phrase as address already processed
          continue;
        }
        seedPhrasesToProcess.push(seedPhrase);
      }

      // Step 6: Show processing summary
      await this.log("=".repeat(60));
      await this.log("💰 CONSOLIDATE PROCESSING SUMMARY:");
      await this.log(`   • Total seed phrases: ${seedPhrases.length}`);
      await this.log(`   • To process: ${seedPhrasesToProcess.length}`);
      await this.log(`   • Already completed: ${seedPhrases.length - seedPhrasesToProcess.length}`);
      await this.log(`   • Target address: ${targetAddress}`);
      await this.log(`   • Batch size: ${this.batchSize} seed phrases`);
      await this.log(`   • Max concurrent per batch: ${config.processing.maxConcurrent} seed phrases`);
      await this.log(`   • Max retries per seed phrase: ${config.api.maxRetries}`);
      await this.log(`   • Skip existing: ${config.processing.skipExisting ? "Enabled" : "Disabled"}`);
      await this.log(`   • Output file: ${config.files.consolidateOutputFile || "consolidate_results.csv"}`);
      await this.log("=".repeat(60));

      if (seedPhrasesToProcess.length === 0) {
        await this.log("✅ All seed phrases have already been processed successfully!");
        this.isRunning = false;
        return;
      }

      // Step 7: Start Consolidate processing
      await this.log("🔄 Starting Consolidate seed phrase processing...");
      await this.processConsolidateSeedPhrases(seedPhrasesToProcess, targetAddress);

      await this.log("=".repeat(60));
      await this.log("🎉 Consolidate processing completed successfully!");
      await this.log(`📊 Final results saved to: ${config.files.consolidateOutputFile || "consolidate_results.csv"}`);
      await this.log(`📝 Detailed logs saved to: ${config.files.logFile}`);
    } catch (error) {
      await this.log(`💥 Fatal error in Consolidate background process: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  async processConsolidateSeedPhrases(seedPhrases, targetAddress) {
    const total = seedPhrases.length;
    const startTime = Date.now();
    let totalSuccess = 0;
    let totalErrors = 0;

    await this.log(
      `🚀 Starting background processing of ${total} consolidate seed phrases in batches of ${this.batchSize}...`
    );

    // Split seed phrases into batches
    const batches = [];
    for (let i = 0; i < seedPhrases.length; i += this.batchSize) {
      batches.push(seedPhrases.slice(i, i + this.batchSize));
    }

    await this.log(`📦 Created ${batches.length} batches for processing`);

    // Process each batch
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchResult = await this.processConsolidateSeedPhraseBatch(batch, targetAddress, i);

      totalSuccess += batchResult.successCount;
      totalErrors += batchResult.errorCount;

      const processed = (i + 1) * this.batchSize;
      const remaining = Math.max(0, total - processed);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const rate = processed / elapsed;
      const eta = remaining > 0 ? Math.round(remaining / rate) : 0;

      await this.log(
        `📊 Consolidate Progress: ${Math.min(processed, total)}/${total} (${Math.round(
          (Math.min(processed, total) / total) * 100
        )}%) | ✅ ${totalSuccess} | ❌ ${totalErrors} | ⏱️ ${elapsed}s | ETA: ${eta}s`
      );

      // Delay between batches
      if (i < batches.length - 1) {
        await this.log(`⏳ Waiting ${config.processing.delayBetweenBatches}ms before next batch...`);
        await new Promise((resolve) => setTimeout(resolve, config.processing.delayBetweenBatches));
      }
    }

    // Final summary
    const totalTime = Math.round((Date.now() - startTime) / 1000);
    const avgRate = total / totalTime;

    await this.log("=".repeat(60));
    await this.log("💰 FINAL CONSOLIDATE PROCESSING SUMMARY:");
    await this.log(`   • Total processed: ${total}`);
    await this.log(`   • Successful: ${totalSuccess} (${Math.round((totalSuccess / total) * 100)}%)`);
    await this.log(`   • Failed: ${totalErrors} (${Math.round((totalErrors / total) * 100)}%)`);
    await this.log(`   • Total time: ${totalTime}s`);
    await this.log(`   • Average rate: ${avgRate.toFixed(2)} seed phrases/second`);
    await this.log(`   • Batches processed: ${batches.length}`);
    await this.log("=".repeat(60));
  }

  async processConsolidateSeedPhraseBatch(seedPhrases, targetAddress, batchIndex) {
    const batchSize = seedPhrases.length;
    const startTime = Date.now();
    let successCount = 0;
    let errorCount = 0;

    await this.log(`🔄 Processing Consolidate batch ${batchIndex + 1} with ${batchSize} seed phrases...`);

    // Create tasks for all seed phrases in this batch
    const tasks = seedPhrases.map((seedPhrase, index) => {
      return () => this.processConsolidateSeedPhrase(seedPhrase, targetAddress, index, batchSize);
    });

    // Process all tasks using async pool
    const results = await Promise.allSettled(tasks.map((task) => this.pool.add(task)));

    // Count results
    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value && !result.value.error) {
        successCount++;
      } else {
        errorCount++;
        if (result.status === "rejected") {
          this.log(`💥 Consolidate Task failed for seed phrase ${index + 1}: ${result.reason}`);
        }
      }
    });

    const batchTime = Math.round((Date.now() - startTime) / 1000);
    const batchRate = batchSize / batchTime;

    await this.log(
      `✅ Consolidate Batch ${
        batchIndex + 1
      } completed: ${successCount}/${batchSize} successful in ${batchTime}s (${batchRate.toFixed(2)} phrases/s)`
    );

    return { successCount, errorCount, batchTime };
  }

  async run() {
    // Run in background mode by default
    await this.runBackground();
  }

  async stop() {
    if (!this.isRunning) {
      await this.log("⚠️ No background process is running!");
      return;
    }

    await this.log("🛑 Stopping background process...");
    this.isRunning = false;
    await this.log("✅ Background process stopped");
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

// Export the class for use in other modules
module.exports = LayerEdgeAllocationChecker;

// Main execution
if (require.main === module) {
  const checker = new LayerEdgeAllocationChecker();
  checker.run().catch(console.error);
}
