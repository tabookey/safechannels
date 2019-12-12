#!/usr/bin/env node

const solc = require('solc');
const fs = require('fs');
const path = require('path');

// TODO: pass all these things as parameters
const projectFolder = "solidity/";
const contractsFolder = projectFolder + "contracts";
const outAbiFolder = "solidity/src/js/generated";

const contractsToExtract = ["SmartAccount", "SmartAccountFactory", "Utilities", "tests/FreeRecipientSponsor", "tests/MockHub", "tests/MockGsnForwarder"];

function compileFile(contractFile, c) {
    console.log("compiling " + contractFile)
    let contractSource = fs.readFileSync(contractFile, {encoding: 'utf8'});

    let input = {
        language: 'Solidity',
        sources: {
            contractFile: {
                content: contractSource
            }
        },
        settings: {
            outputSelection: {
                '*': {
                    '*': ['*']
                }
            }
        }
    };
    let result;
    let abi;
    let binary;
    let parts = c.split('/');
    let lastSegment = parts.pop() || parts.pop();
    try {
        let compile = solc.compile(JSON.stringify(input), function (path) {
            let subPath = parts.length == 0 ? "" : "/" + parts.join("/")
            let realPath = contractsFolder + subPath + "/" + path;
            if (!fs.existsSync(realPath)) {
                realPath = projectFolder + "node_modules/" + path;
            }
            console.log(fs.existsSync(realPath) ? "resolved:" : "failed to resolve", realPath);

            return {
                'contents': fs.readFileSync(realPath).toString()
            }
        });
        result = JSON.parse(compile);
        abi = JSON.stringify(result.contracts.contractFile[lastSegment].abi);
        binary = result.contracts.contractFile[lastSegment].evm.bytecode.object;
    } catch (e) {
        console.log(e)
    }
    if (!abi) {
        console.log("ERROR: failed to extract abi:", result);
        process.exit(1)
    }

    return {abi, binary};
}

contractsToExtract.forEach(c => {

    let contractFile = contractsFolder + "/" + c + ".sol";
    let outNodeFile = outAbiFolder + "/" + c + ".js";
    let outAbiFile = outAbiFolder + "/" + c + ".json";
    let outBinFile = outAbiFolder + "/" + c + ".bin";
    //TODO: Cannot depend on timestamps when working with interdependent contracts
    /*
    try {
        if (fs.existsSync(outAbiFile) &&
            fs.statSync(contractFile).mtime <= fs.statSync(outAbiFile).mtime) {
            console.log("not modified: ", contractFile);
            return;
        }
    } catch (e) {
        console.log(e);
    }
    */
    let {abi, binary} = compileFile(contractFile, c);

    createDirectories(outAbiFile, function () {
        fs.writeFileSync(outAbiFile, abi);
        fs.writeFileSync(outNodeFile, "module.exports=" + abi);
        fs.writeFileSync(outBinFile, binary);
        console.log("written \"" + outAbiFile + "\"");
        console.log("written \"" + outNodeFile + "\"");
        console.log("written \"" + outBinFile + "\"");
    })
});


function createDirectories(pathname, callback) {
    const __dirname = path.resolve();
    pathname = pathname.replace(/^\.*\/|\/?[^\/]+\.[a-z]+|\/$/g, ''); // Remove leading directory markers, and remove ending /file-name.extension
    fs.mkdir(path.resolve(__dirname, pathname), { recursive: true }, e => {
        if (e) {
            console.error(e);
        }
        callback(e)
    });
}