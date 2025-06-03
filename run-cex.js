// Script to run CEX workflow
const LayerEdgeAllocationChecker = require('./index.js');

async function runCexWorkflow() {
    console.log('🏦 Starting LayerEdge CEX Workflow...');
    console.log('='.repeat(50));
    
    const checker = new LayerEdgeAllocationChecker();
    
    // Show initial status
    console.log('Initial Status:', checker.getStatus());
    
    // Start the CEX background process
    console.log('\n🚀 Starting CEX background process...');
    
    try {
        await checker.runCexBackground();
        console.log('\n✅ CEX workflow completed successfully!');
    } catch (error) {
        console.error('\n❌ CEX workflow failed:', error.message);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    process.exit(0);
});

runCexWorkflow().catch(console.error);
