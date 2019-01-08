import {Config} from './config';
import {Readable} from "stream";

const AWS = require('aws-sdk');
const ftp = require('ftp');
const fs = require('fs');
const archiver = require('archiver');

const s3 = new AWS.S3();
const config = new Config();

export async function handler(event) {
    return Promise.all(
        event.Records
            .filter(record => record.s3.object.key.endsWith('csv'))
            .slice(0, 1)
            .map(record => {
                const bucket = record.s3.bucket.name;
                const key = record.s3.object.key;
                const today = new Date();
                today.setDate(today.getDate() - 1);
                const yesterday = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
                const dst = `theguardian_${yesterday}.${config.ZipFile ? 'zip' : 'csv'}`;
                console.log(`Streaming ${bucket}/${key} to ${dst}`);

                if (config.ZipFile) {
                    return streamS3ToLocalZip(bucket, key)
                        .then(fileName => 
                            ftpConnect(config.FtpHost, config.FtpUser, config.FtpPassword)
                                .then(ftpClient => streamLocalToFtp(fileName, dst, ftpClient))
                        );
                } else {
                    return ftpConnect(config.FtpHost, config.FtpUser, config.FtpPassword)
                        .then(ftpClient => streamS3FileToFtp(bucket, key, dst, ftpClient))
                }
            })
    );
}

function pad(n: number): string {
    return n.toString(10).padStart(2, '0');
}

/**
 * Creates a new ftp connection and returns the ftp client.
 */
function ftpConnect(host: string, user: string, password: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const ftpClient = new ftp();

        ftpClient.connect({
            host,
            user,
            password
        });

        ftpClient.on('ready', () => {
            resolve(ftpClient)
        });
        ftpClient.on('error', (err) => {
            console.log("FTP error: ", err);
            reject(err)
        });
    })
}

/**
 * Pipes the stream to the ftp session under the given path.
 */
function streamToFtp(stream: Readable, path: string, ftpClient): Promise<string> {
    return new Promise((resolve, reject) => {
        stream.on('readable', () => {
            ftpClient.put(stream, path, (err) => {
                if (err) {
                    console.log(`Error writing ${path} to ftp`, err);
                    reject(err)
                }
            })
        });

        stream.on('end', () => {
            resolve(path)
        });

        stream.on('error', (err: Error) => {
            console.log(`Error streaming ${path} to ftp`, err);
            reject(err)
        });
    })
}

/**
 * Streams the given s3 object to the given ftp session.
 */
function streamS3FileToFtp(bucket: string, key: string, dst: string, ftpClient): Promise<string> {
    const stream: Readable = s3.getObject({
        Bucket: bucket,
        Key: key
    }).createReadStream();

    return streamToFtp(stream, dst, ftpClient)
}

/**
 * Streams the given s3 object to a local zip archive.
 */
function streamS3ToLocalZip(bucket: string, key: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const stream: Readable = s3.getObject({
            Bucket: bucket,
            Key: key
        }).createReadStream();

        const outputFile = `/tmp/${key}.zip`;

        const output = fs.createWriteStream(outputFile);
        const archive = archiver('zip');

        archive.pipe(output);

        archive.append(stream, { name: key });
        archive.finalize();

        stream.on('end', () => {
            resolve(outputFile);
        });

        stream.on('error', (err: Error) => {
            console.log(`Error streaming ${key} to archive`, err);
            reject(err);
        });

        archive.on('error', (err) => {
            console.log(`Error archiving ${key}`, err);
            reject(err);
        });
    })
}

/**
 * Streams the given local file to the given ftp session.
 */
function streamLocalToFtp(path: string, dst: string, ftpClient): Promise<string> {
    const stream = fs.createReadStream(path);

    return streamToFtp(stream, dst, ftpClient)
}