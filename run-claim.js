// Script to run Claim workflow
const LayerEdgeAllocationChecker = require('./index.js');

async function runClaimWorkflow() {
    console.log('🎯 Starting LayerEdge Claim Workflow...');
    console.log('='.repeat(50));
    
    const checker = new LayerEdgeAllocationChecker();
    
    // Show initial status
    console.log('Initial Status:', checker.getStatus());
    
    // Start the Claim background process
    console.log('\n🚀 Starting Claim background process...');
    
    try {
        await checker.runClaimBackground();
        console.log('\n✅ Claim workflow completed successfully!');
    } catch (error) {
        console.error('\n❌ Claim workflow failed:', error.message);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    process.exit(0);
});

runClaimWorkflow().catch(console.error);
