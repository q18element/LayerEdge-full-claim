# LayerEdge Allocation Checker

A Node.js tool to check LayerEdge allocation for multiple Ethereum addresses with proxy support and retry mechanisms.

## Features

- 🚀 **Background Processing**: Runs continuously in background mode
- 📦 **Batch Processing**: Processes 100 addresses at a time (configurable)
- ⚡ **High Concurrency**: Up to 100 concurrent requests per batch
- 🔄 **Proxy Rotation**: Thread-safe proxy rotation with mutex
- 🔁 **Retry Mechanism**: Up to 100 retries per address with delays
- 💾 **Resume Capability**: Skips already processed addresses
- 📊 **Real-time Progress**: Live statistics and ETA
- 📝 **Comprehensive Logging**: Detailed logs with timestamps
- ⚙️ **Easy Configuration**: JSON-based configuration

## Installation

1. Install Node.js dependencies:
```bash
npm install
```

## Configuration

Edit `config.json` to customize the behavior:

- `api.maxRetries`: Maximum number of retries per address (default: 100)
- `api.retryDelay`: Delay between retries in milliseconds (default: 1000)
- `processing.concurrency`: Number of concurrent requests (default: 5)
- `processing.proxyRotation`: Enable/disable proxy rotation (default: true)
- `processing.skipExisting`: Skip addresses already in results file (default: true)
- `cexInfo.platform`: CEX platform name (default: "gate")
- `cexInfo.depositAddress`: CEX deposit address
- `cexInfo.userId`: CEX user ID
- `consolidate.targetAddress`: Target address for ETH consolidation

## Setup Input Files

1. **addresses.txt**: Add Ethereum addresses, one per line
```

0x1234567890123456789012345678901234567890
```

2. **seedphrases.txt**: Add seed phrases for CEX workflow, one per line
```
abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about
another seed phrase here with twelve or more words
```

3. **data.csv**: Add transfer data for ETH transfer workflow
```
seedPhrase,toAddress
abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about,0x4eC5Cc3C7575f4fD809852AE1e3FEdcbF213a84D
word1 word2 word3 ... word12,0x1234567890123456789012345678901234567890
```

4. **proxy.txt**: Add proxy servers, one per line (optional)
```
http://username:password@proxy.example.com:8080
https://proxy.example.com:8080
socks5://username:password@proxy.example.com:1080
```

## Usage

### Allocation Checker (Main Workflow)
Run the allocation checker:
```bash
npm start
```

Or directly with Node.js:
```bash
node index.js
```

### CEX Connector Workflow
Run the CEX connector for seed phrases:
```bash
npm run cex
```

Or directly with Node.js:
```bash
node run-cex.js
```

### Claim Processor Workflow
Run the claim processor for seed phrases:
```bash
npm run claim
```

Or directly with Node.js:
```bash
node run-claim.js
```

### ETH Consolidate Workflow
Run the ETH consolidate processor for seed phrases:
```bash
npm run consolidate
```

Or directly with Node.js:
```bash
node run-consolidate.js
```

### ETH Transfer Workflow
Run the ETH transfer processor for CSV data:
```bash
npm run transfer
```

Or directly with Node.js:
```bash
node run-transfer.js
```

## How It Works

The tool follows this automated workflow:

1. **🔧 Setup Phase**
   - Loads configuration from `config.json`
   - Reads addresses from `addresses.txt`
   - Reads proxies from `proxy.txt` (if available)

2. **📡 Proxy Validation**
   - Tests each proxy for connectivity
   - Removes non-working proxies
   - Shows IP addresses for working proxies
   - Continues with direct connection if no proxies work

3. **📄 Resume Check**
   - Loads existing results from `results.csv`
   - Skips addresses that were already processed successfully
   - Shows how many addresses need processing

4. **🔄 Processing Phase**
   - Processes addresses concurrently (configurable)
   - Rotates through working proxies
   - Retries failed requests up to 100 times
   - Shows real-time progress and statistics
   - Saves results periodically

5. **📊 Completion**
   - Shows final statistics
   - Saves all results to CSV
   - Provides detailed logs

## Output

### Allocation Checker Output
- **results.csv**: Contains allocation data for all processed addresses
- **allocation_checker.log**: Detailed logs of the process

### CEX Connector Output
- **cex_results.csv**: Contains CEX connection results (address,data format)
- **allocation_checker.log**: Detailed logs of the process

### Claim Processor Output
- **claim_results.csv**: Contains claim processing results (address,data format)
- **allocation_checker.log**: Detailed logs of the process

### ETH Consolidate Output
- **consolidate_results.csv**: Contains ETH consolidation results (address,data format)
- **allocation_checker.log**: Detailed logs of the process

### CSV Columns

- `Address`: Ethereum address
- `Allocation`: Current allocation amount
- `InitAllocation`: Initial allocation amount
- `Proof`: Merkle proof (JSON array)
- `Details`: Additional details (JSON object)
- `Timestamp`: When the data was fetched
- `Proxy`: Which proxy was used (if any)
- `Error`: Error message (if failed)

## Resume Capability

The tool automatically resumes from where it left off by:
- Reading existing results from `results.csv`
- Skipping addresses that were already processed successfully
- This prevents duplicate API calls and saves time

## Proxy Support

- Proxies are automatically validated before use
- Failed proxies are removed from rotation
- Supports HTTP, HTTPS, and SOCKS5 proxies
- Automatic rotation for load balancing

## Error Handling

- Automatic retry with exponential backoff
- Detailed error logging
- Graceful handling of network issues
- Continues processing even if some addresses fail

## Monitoring

- Real-time console output
- Detailed log file with timestamps
- Progress tracking (current/total)
- Success/failure statistics
