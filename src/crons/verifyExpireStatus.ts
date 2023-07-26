import cron from "node-cron";
import { logErrorToConsole, logToConsole } from "../utils/general.ts";

import { and, eq, lte } from "drizzle-orm";
import { DEANSLIST_EMAIL } from "../constants/EMAIL.ts";
import { UNDERDOG_BUSINESS_VISA_PROJECT_ID } from "../constants/UNDERDOG.ts";
import db from "../db/index.ts";
import { usersTable } from "../db/schema/index.ts";
import underdogApiInstance from "../services/underdog.ts";
import type { NftDetails } from "../types/underdog.ts";
import resend from "../services/resend.ts";
import VISA_STATUS from "../constants/VISA_STATUS.ts";
import { BUSINESS_VISA_PAYMENT_LINK_URL } from "../constants/SPHERE_PAY.ts";

const verifyExpireStatus = async () => {
    try {
        logToConsole("verifyExpireStatusJob started!");

        const expiredVisaUsers = await db
            .select()
            .from(usersTable)
            .where(
                and(
                    eq(usersTable.nftType, "business"),
                    eq(usersTable.nftStatus, VISA_STATUS.ACTIVE),
                    lte(usersTable.nftExpiresAt, new Date())
                )
            );

        if (!expiredVisaUsers) {
            throw new Error("No expiredVisaUsers found from db!");
        }

        if (expiredVisaUsers.length === 0) {
            logToConsole("No expired business visa users!");
        }

        for (const user of expiredVisaUsers) {
            try {
                if (!user.nftId) {
                    throw new Error(`No nft id found for user id ${user.id}`);
                }

                const nftUpdateResponse = await underdogApiInstance.patch(
                    `/v2/projects/n/${UNDERDOG_BUSINESS_VISA_PROJECT_ID}/nfts/${user.nftId}`,
                    {
                        attributes: {
                            issuedAt: user.nftIssuedAt?.getTime().toString(),
                            expiresAt: user.nftExpiresAt?.getTime().toString(),
                            status: VISA_STATUS.EXPIRED,
                        },
                    }
                );

                const nftUpdateResponseData =
                    nftUpdateResponse.data as NftDetails | null;

                console.log("nftDetails", nftUpdateResponseData);

                if (!nftUpdateResponseData) {
                    throw new Error("Nft failed to update");
                }

                await db
                    .update(usersTable)
                    .set({
                        nftStatus: VISA_STATUS.EXPIRED,
                    })
                    .where(eq(usersTable.id, user.id));

                await resend.sendEmail({
                    from: DEANSLIST_EMAIL,
                    to: user.email,
                    subject: "Your business visa has been expired!",
                    text: `Your business visa nft has been expired please renew using this link! ${BUSINESS_VISA_PAYMENT_LINK_URL}`,
                });

                // logToConsole(
                //     "nft claimed successfully for applicant id",
                //     user.id
                // );
            } catch (error) {
                logErrorToConsole(
                    "Something went wrong to update nft status for user id",
                    user.id
                );
            }
        }

        logToConsole("verifyClaimStatusJob completed successfully!");
    } catch (error) {
        logErrorToConsole("verifyClaimStatusJob error =>", error);
    }
};

// it runs every 15 minutes
const verifyExpireStatusJob = cron.schedule("*/15 * * * *", verifyExpireStatus);

// for testing it runs every 1 minute
// const verifyExpireStatusJob = cron.schedule("*/1 * * * *", verifyExpireStatus);

export default verifyExpireStatusJob;