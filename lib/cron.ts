import { getLatestPost, getPost, getNewStories, getTopStories } from "./hn";
import {
  getLastCheckedId,
  setLastCheckedId,
  checkIfPostWasChecked,
  getTeamsAndKeywords,
} from "./upstash";
import { equalsIgnoreOrder, postScanner  } from "./helpers";
import { sendSlackMessage } from "./slack";

export async function cron() {
  // Get latest new stories from Hacker News (more efficient than checking all posts)
  const newStoryIds = await getTopStories(30); // Get top 10 new stories
  
  const teamsAndKeywords = await getTeamsAndKeywords(); // get all team keys from redis
  const scanner = postScanner(teamsAndKeywords); // create a post scanner that contains all teams and their keywords in a constructed regex

  let results: {
    [postId: string]: string[]; // for each post, store the teams that it was sent to
  } = {};
  let errors: any[] = [];
  let processedCount = 0;

  for (const postId of newStoryIds) {
    if (await checkIfPostWasChecked(postId)) continue; // avoid double checking posts

    const post = await getPost(postId); // get post from hacker news
    if (!post) {
      console.log(`Hacker News post not found. Post number: ${postId}`);
      continue;
    }
    if (post.deleted || post.type !== "story" || !post?.url) {
      console.log(`Skipping post ${postId} because it's deleted or not a story or doesn't have a url`);
      continue; // if post is deleted or not a story (skip comments), skip it
    }
    
    processedCount++;
    console.log("checking for keywords in story", postId);
    const interestedTeams = Array.from(scanner(post)); // get teams that are interested in this post
    if (interestedTeams.length > 0) {
      results[postId] = interestedTeams; // add post id and interested teams to results
      await Promise.all(
        interestedTeams.map(async (teamId) => {
          console.log("sending story to team", teamId);
          try {
            await sendSlackMessage(postId, teamId); // send post to team
          } catch (e) {
            console.log(
              `Error sending post ${postId} to team ${teamId}. Cause of error: ${e}`
            );
            errors.push({
              error: e,
              postId: postId,
              teamId: teamId,
            }); // if there's an error, add it to errors
          }
        })
      );
    }
  }

  return {
    summary: `Processed ${processedCount} new stories from Hacker News`,
    results,
    errors,
    totalStories: newStoryIds.length,
    processedStories: processedCount,
  };
}

export async function testCron(
  postsToTest: number[],
  fakeTeamsAndKeywords: { [teamId: string]: string[] },
  fakeInterestedTeams: { [postId: number]: string[] }
) {
  const scanner = postScanner(fakeTeamsAndKeywords);
  let results: { [postId: number]: string } = {};
  for (const id of postsToTest) {
    console.log(`checking for post ${id}`);
    const post = await getPost(id); // get post from hacker news
    if (!post) {
      results[id] = `Hacker News post not found.`;
      continue;
    }
    if (post.deleted) {
      continue; // if post is deleted, skip it
    }
    const interestedTeams = Array.from(scanner(post)); // get teams that are interested in this post
    if (!equalsIgnoreOrder(fakeInterestedTeams[id], interestedTeams)) {
      results[
        id
      ] = `Interested teams don't match. Expected: ${fakeInterestedTeams[id]}, Actual: ${interestedTeams}`;
    }
  }
  return {
    message:
      Object.keys(results).length > 0
        ? "Some tests failing"
        : "All tests passed",
    results,
  };
}
