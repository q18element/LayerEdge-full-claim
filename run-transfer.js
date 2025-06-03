// Script to run Transfer workflow
const TransferProcessor = require('./transfer-processor.js');

async function runTransferWorkflow() {
    console.log('💸 Starting LayerEdge ETH Transfer Workflow...');
    console.log('='.repeat(50));
    
    const processor = new TransferProcessor();
    
    // Show initial status
    console.log('Initial Status:', processor.getStatus());
    
    try {
        if (processor.isRunning) {
            console.log("⚠️ Transfer process is already running!");
            return;
        }

        processor.isRunning = true;

        console.log("💸 Starting LayerEdge ETH Transfer Processor...");
        console.log("=".repeat(60));

        // Step 1: Load proxies
        console.log("📡 Step 1: Loading proxies...");
        await processor.loadProxies();

        // Step 2: Load existing results
        console.log("📄 Step 2: Loading existing transfer results...");
        await processor.loadExistingResults();

        // Step 3: Load transfer data from CSV
        console.log("📊 Step 3: Loading transfer data from data.csv...");
        const transferData = await processor.loadDataFromCSV();

        if (transferData.length === 0) {
            throw new Error("No transfer data to process");
        }

        // Step 4: Filter data based on existing results
        const dataToProcess = [];
        for (const record of transferData) {
            const { ethers } = require('ethers');
            const wallet = ethers.Wallet.fromPhrase(record.seedPhrase);
            const fromAddress = wallet.address;

            if (processor.existingResults.has(fromAddress)) {
                // Skip this record as address already processed
                continue;
            }
            dataToProcess.push(record);
        }

        // Step 5: Show processing summary
        console.log("=".repeat(60));
        console.log("💸 TRANSFER PROCESSING SUMMARY:");
        console.log(`   • Total transfer records: ${transferData.length}`);
        console.log(`   • To process: ${dataToProcess.length}`);
        console.log(`   • Already completed: ${transferData.length - dataToProcess.length}`);
        console.log(`   • Working proxies: ${processor.proxies.length}`);
        console.log(`   • Batch size: ${processor.batchSize} transfers`);
        console.log(`   • Max concurrent per batch: ${require('./config.json').processing.maxConcurrent} transfers`);
        console.log(`   • Max retries per transfer: ${require('./config.json').api.maxRetries}`);
        console.log(`   • Proxy rotation: ${require('./config.json').processing.proxyRotation ? "Enabled" : "Disabled"}`);
        console.log(`   • Skip existing: ${require('./config.json').processing.skipExisting ? "Enabled" : "Disabled"}`);
        console.log(`   • Output file: transfer_results.csv`);
        console.log("=".repeat(60));

        if (dataToProcess.length === 0) {
            console.log("✅ All transfer records have already been processed successfully!");
            processor.isRunning = false;
            return;
        }

        // Step 6: Start Transfer processing
        console.log("🔄 Starting transfer processing...");
        await processTransfers(processor, dataToProcess);

        console.log("=".repeat(60));
        console.log("🎉 Transfer processing completed successfully!");
        console.log(`📊 Final results saved to: transfer_results.csv`);
        console.log(`📝 Detailed logs saved to: transfer_processor.log`);

    } catch (error) {
        console.log(`💥 Fatal error in transfer process: ${error.message}`);
    } finally {
        processor.isRunning = false;
    }
}

async function processTransfers(processor, transferData) {
    const total = transferData.length;
    const startTime = Date.now();
    let totalSuccess = 0;
    let totalErrors = 0;

    console.log(`🚀 Starting processing of ${total} transfers in batches of ${processor.batchSize}...`);

    // Split data into batches
    const batches = [];
    for (let i = 0; i < transferData.length; i += processor.batchSize) {
        batches.push(transferData.slice(i, i + processor.batchSize));
    }

    console.log(`📦 Created ${batches.length} batches for processing`);

    // Process each batch
    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const batchResult = await processTransferBatch(processor, batch, i);

        totalSuccess += batchResult.successCount;
        totalErrors += batchResult.errorCount;

        const processed = (i + 1) * processor.batchSize;
        const remaining = Math.max(0, total - processed);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const rate = processed / elapsed;
        const eta = remaining > 0 ? Math.round(remaining / rate) : 0;

        console.log(
            `📊 Transfer Progress: ${Math.min(processed, total)}/${total} (${Math.round(
                (Math.min(processed, total) / total) * 100
            )}%) | ✅ ${totalSuccess} | ❌ ${totalErrors} | ⏱️ ${elapsed}s | ETA: ${eta}s`
        );

        // Delay between batches
        if (i < batches.length - 1) {
            const config = require('./config.json');
            console.log(`⏳ Waiting ${config.processing.delayBetweenBatches}ms before next batch...`);
            await new Promise((resolve) => setTimeout(resolve, config.processing.delayBetweenBatches));
        }
    }

    // Final summary
    const totalTime = Math.round((Date.now() - startTime) / 1000);
    const avgRate = total / totalTime;

    console.log("=".repeat(60));
    console.log("💸 FINAL TRANSFER PROCESSING SUMMARY:");
    console.log(`   • Total processed: ${total}`);
    console.log(`   • Successful: ${totalSuccess} (${Math.round((totalSuccess / total) * 100)}%)`);
    console.log(`   • Failed: ${totalErrors} (${Math.round((totalErrors / total) * 100)}%)`);
    console.log(`   • Total time: ${totalTime}s`);
    console.log(`   • Average rate: ${avgRate.toFixed(2)} transfers/second`);
    console.log(`   • Batches processed: ${batches.length}`);
    console.log("=".repeat(60));
}

async function processTransferBatch(processor, transferData, batchIndex) {
    const batchSize = transferData.length;
    const startTime = Date.now();
    let successCount = 0;
    let errorCount = 0;

    console.log(`🔄 Processing Transfer batch ${batchIndex + 1} with ${batchSize} transfers...`);

    // Create tasks for all transfers in this batch
    const tasks = transferData.map((record, index) => {
        return () => processor.processTransferRecord(record, index, batchSize);
    });

    // Process all tasks using async pool
    const results = await Promise.allSettled(tasks.map((task) => processor.pool.add(task)));

    // Count results
    results.forEach((result, index) => {
        if (result.status === "fulfilled" && result.value && !result.value.error) {
            successCount++;
        } else {
            errorCount++;
            if (result.status === "rejected") {
                console.log(`💥 Transfer Task failed for record ${index + 1}: ${result.reason}`);
            }
        }
    });

    const batchTime = Math.round((Date.now() - startTime) / 1000);
    const batchRate = batchSize / batchTime;

    console.log(
        `✅ Transfer Batch ${
            batchIndex + 1
        } completed: ${successCount}/${batchSize} successful in ${batchTime}s (${batchRate.toFixed(2)} transfers/s)`
    );

    return { successCount, errorCount, batchTime };
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    process.exit(0);
});

runTransferWorkflow().catch(console.error);
